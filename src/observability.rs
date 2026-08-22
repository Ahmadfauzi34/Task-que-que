use std::sync::OnceLock;

use opentelemetry::global;
use opentelemetry_otlp::WithExportConfig;
use opentelemetry_sdk::trace::{self as sdktrace, RandomIdGenerator, Sampler};
use opentelemetry_sdk::Resource;
use tracing::level_filters::LevelFilter;
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::SubscriberInitExt;
use tracing_subscriber::EnvFilter;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExporterKind {
    None,
    Console,
    Json,
}

#[derive(Debug, Clone)]
pub struct ObservabilityConfig {
    pub service_name: String,
    pub service_version: String,
    pub log_exporter: ExporterKind,
    pub trace_level: LevelFilter,
    pub otlp_endpoint: Option<String>,
}

impl Default for ObservabilityConfig {
    fn default() -> Self {
        Self {
            service_name: "robust-sinkhorn-queue".to_string(),
            service_version: env!("CARGO_PKG_VERSION").to_string(),
            log_exporter: ExporterKind::Console,
            trace_level: LevelFilter::INFO,
            otlp_endpoint: None,
        }
    }
}

pub struct ShutdownGuard {
    _tracer_provider: Option<sdktrace::TracerProvider>,
}

impl Drop for ShutdownGuard {
    fn drop(&mut self) {
        global::shutdown_tracer_provider();
    }
}

static INITIALIZED: OnceLock<()> = OnceLock::new();

pub fn init(config: ObservabilityConfig) -> ShutdownGuard {
    if INITIALIZED.get().is_some() {
        return ShutdownGuard {
            _tracer_provider: None,
        };
    }

    let resource = Resource::new(vec![
        opentelemetry::KeyValue::new("service.name", config.service_name.clone()),
        opentelemetry::KeyValue::new("service.version", config.service_version.clone()),
    ]);

    let tracer_provider = if let Some(endpoint) = config.otlp_endpoint.as_ref() {
        let exporter = opentelemetry_otlp::new_exporter()
            .tonic()
            .with_endpoint(endpoint);

        let tracer = opentelemetry_otlp::new_pipeline()
            .tracing()
            .with_exporter(exporter)
            .with_trace_config(
                sdktrace::config()
                    .with_sampler(Sampler::AlwaysOn)
                    .with_id_generator(RandomIdGenerator::default())
                    .with_resource(resource),
            )
            .install_batch(opentelemetry_sdk::runtime::Tokio)
            .expect("failed to install OTLP pipeline");

        opentelemetry::global::set_text_map_propagator(
            opentelemetry_sdk::propagation::TraceContextPropagator::new(),
        );

        Some((None::<sdktrace::TracerProvider>, tracer))
    } else {
        let provider = sdktrace::TracerProvider::builder()
            .with_config(
                sdktrace::config()
                    .with_sampler(Sampler::AlwaysOn)
                    .with_id_generator(RandomIdGenerator::default())
                    .with_resource(resource),
            )
            .build();
        use opentelemetry::trace::TracerProvider as _;
        let tracer = provider.tracer(config.service_name.clone());
        global::set_tracer_provider(provider.clone());
        Some((Some(provider), tracer))
    };

    let env_filter = EnvFilter::builder()
        .with_default_directive(config.trace_level.into())
        .from_env_lossy();

    let tracer = tracer_provider.as_ref().map(|(_, tracer)| tracer.clone());

    let registry = tracing_subscriber::registry().with(env_filter);

    match config.log_exporter {
        ExporterKind::None => {
            let otel_layer = tracer.map(|t| tracing_opentelemetry::layer().with_tracer(t));
            registry.with(otel_layer).init();
        }
        ExporterKind::Console => {
            let otel_layer = tracer.map(|t| tracing_opentelemetry::layer().with_tracer(t));
            let fmt_layer = tracing_subscriber::fmt::layer()
                .with_ansi(true)
                .with_target(true)
                .with_thread_ids(false)
                .with_file(false)
                .with_line_number(false);
            registry.with(fmt_layer).with(otel_layer).init();
        }
        ExporterKind::Json => {
            let otel_layer = tracer.map(|t| tracing_opentelemetry::layer().with_tracer(t));
            let fmt_layer = tracing_subscriber::fmt::layer()
                .json()
                .with_current_span(true)
                .with_span_list(true)
                .with_target(true);
            registry.with(fmt_layer).with(otel_layer).init();
        }
    }

    INITIALIZED.get_or_init(|| ());

    tracing::info!(
        service.name = %config.service_name,
        service.version = %config.service_version,
        otlp.enabled = config.otlp_endpoint.is_some(),
        "observability initialized"
    );

    ShutdownGuard {
        _tracer_provider: tracer_provider.and_then(|(p, _)| p),
    }
}
