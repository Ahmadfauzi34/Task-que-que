# Kontrak Eksekusi Workflow

Spesifikasi bagaimana agen mengeksekusi `workflow.run` dan `agent.invoke`.
Semua implementasi (TypeScript, Python, bahasa lain) WAJIB mengikuti ini.

## workflow.run

### Input
```json
{
  "type": "workflow.run",
  "payload": {
    "steps": [
      {"agent": "nama-agen", "tool": "nama-tool", "arguments": {...}},
      ...
    ]
  }
}
```

### Aturan Eksekusi

1. **Filter agen**: Agen HANYA mengeksekusi step dimana `step.agent == agent_id_sendiri`.
   Step untuk agen lain HARUS di-skip (bukan error).

2. **Hasil step yang di-skip**:
   ```json
   {"step": <index>, "skipped": true, "reason": "not for this agent"}
   ```

3. **Hasil step yang dieksekusi**:
   ```json
   {"step": <index>, "agent": "<id>", "tool": "<tool>", "mcp_result": <hasil MCP>}
   ```

4. **Urutan**: Step dieksekusi BERURUTAN (sequential), bukan paralel.
   Alasan: step N+1 mungkin bergantung pada hasil step N.

5. **Error**: Jika satu step gagal, STOP eksekusi dan laporkan error.
   Jangan lanjutkan ke step berikutnya.

6. **Hasil akhir**:
   ```json
   {"steps_completed": <n>, "results": [...]}
   ```

### Validasi
- `steps` harus array non-empty, max 16 steps
- Setiap step harus punya `agent` (string) dan `tool` (string)
- `arguments` opsional, default `{}`

## agent.invoke

### Input
```json
{
  "type": "agent.invoke",
  "payload": {
    "agent": "nama-agen",
    "tool": "nama-tool",
    "arguments": {...}
  }
}
```

### Aturan Eksekusi

1. **Verifikasi**: Jika `payload.agent != agent_id_sendiri`, REJECT dengan error.
   (Berbeda dengan workflow.run yang skip — invoke adalah delegasi langsung.)

2. **Eksekusi**: Satu MCP `tools/call` dengan `tool` dan `arguments`.

3. **Hasil**:
   ```json
   {"agent": "<id>", "tool": "<tool>", "mcp_result": <hasil MCP>}
   ```

## MCP Protocol

Setiap eksekusi tool via MCP HARUS mengikuti:
1. `initialize` dengan `protocolVersion: "2024-11-05"`
2. `notifications/initialized` (tidak perlu tunggu respons)
3. `tools/call` dengan `{name, arguments}`

Timeout per MCP call: 30 detik.
