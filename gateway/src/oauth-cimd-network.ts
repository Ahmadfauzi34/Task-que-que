import { isIP } from "node:net";

function parseIpv4(
  value: string,
): readonly number[] | null {
  const parts = value.split(".");
  if (parts.length !== 4) return null;

  const bytes: number[] = [];
  for (const part of parts) {
    if (!/^(0|[1-9][0-9]{0,2})$/.test(part)) {
      return null;
    }
    const byte = Number(part);
    if (byte < 0 || byte > 255) return null;
    bytes.push(byte);
  }
  return bytes;
}

function parseIpv6(
  raw: string,
): Uint8Array | null {
  let value = raw.toLowerCase();

  if (
    value.startsWith("[")
    && value.endsWith("]")
  ) {
    value = value.slice(1, -1);
  }

  if (
    value.includes("%")
    || isIP(value) !== 6
  ) {
    return null;
  }

  let ipv4Tail:
    readonly number[] | null = null;

  const lastColon =
    value.lastIndexOf(":");
  const tail =
    value.slice(lastColon + 1);

  if (tail.includes(".")) {
    ipv4Tail = parseIpv4(tail);
    if (!ipv4Tail) return null;

    const hi =
      ((ipv4Tail[0]! << 8)
        | ipv4Tail[1]!)
      .toString(16);
    const lo =
      ((ipv4Tail[2]! << 8)
        | ipv4Tail[3]!)
      .toString(16);

    value =
      `${value.slice(0, lastColon)}:${hi}:${lo}`;
  }

  const halves = value.split("::");
  if (halves.length > 2) return null;

  const left = halves[0]
    ? halves[0]!.split(":")
    : [];
  const right =
    halves.length === 2
      && halves[1]
      ? halves[1]!.split(":")
      : [];

  if (
    left.some((part) =>
      !/^[0-9a-f]{1,4}$/.test(part))
    || right.some((part) =>
      !/^[0-9a-f]{1,4}$/.test(part))
  ) {
    return null;
  }

  let groups: string[];
  if (halves.length === 1) {
    if (left.length !== 8) return null;
    groups = left;
  } else {
    const missing =
      8 - left.length - right.length;
    if (missing < 1) return null;
    groups = [
      ...left,
      ...Array(missing).fill("0"),
      ...right,
    ];
  }

  if (groups.length !== 8) {
    return null;
  }

  const bytes =
    new Uint8Array(16);

  groups.forEach((group, index) => {
    const number =
      Number.parseInt(group, 16);
    bytes[index * 2] =
      (number >> 8) & 0xff;
    bytes[index * 2 + 1] =
      number & 0xff;
  });

  return bytes;
}

function ipv4SpecialUse(
  bytes: readonly number[],
): boolean {
  const [a, b, c] = bytes;

  return (
    a === 0
    || a === 10
    || a === 127
    || (
      a === 100
      && b! >= 64
      && b! <= 127
    )
    || (
      a === 169
      && b === 254
    )
    || (
      a === 172
      && b! >= 16
      && b! <= 31
    )
    || (
      a === 192
      && b === 0
      && c === 0
    )
    || (
      a === 192
      && b === 0
      && c === 2
    )
    || (
      a === 192
      && b === 88
      && c === 99
    )
    || (
      a === 192
      && b === 168
    )
    || (
      a === 198
      && (
        b === 18
        || b === 19
      )
    )
    || (
      a === 198
      && b === 51
      && c === 100
    )
    || (
      a === 203
      && b === 0
      && c === 113
    )
    || a! >= 224
  );
}

function prefixMatches(
  bytes: Uint8Array,
  prefix: readonly number[],
  bits: number,
): boolean {
  const whole = Math.floor(bits / 8);
  const remainder = bits % 8;

  for (let index = 0; index < whole; index += 1) {
    if (bytes[index] !== prefix[index]) {
      return false;
    }
  }

  if (remainder === 0) {
    return true;
  }

  const mask =
    (0xff << (8 - remainder)) & 0xff;

  return (
    (bytes[whole]! & mask)
      === (prefix[whole]! & mask)
  );
}

function ipv6SpecialUse(
  bytes: Uint8Array,
): boolean {
  const prefixes: Array<
    [readonly number[], number]
  > = [
    [[0x00], 8],
    [[0x00, 0x64, 0xff, 0x9b], 96],
    [[0x01, 0x00], 64],
    [[0x20, 0x01, 0x00], 23],
    [[0x20, 0x01, 0x0d, 0xb8], 32],
    [[0x20, 0x02], 16],
    [[0x3f, 0xff, 0x00], 20],
    [[0xfc], 7],
    [[0xfe, 0x80], 10],
    [[0xff], 8],
  ];

  return prefixes.some(
    ([prefix, bits]) =>
      prefixMatches(
        bytes,
        prefix,
        bits,
      ),
  );
}

export function isSpecialUseIpAddress(
  address: string,
): boolean {
  const version = isIP(
    address.startsWith("[")
      && address.endsWith("]")
      ? address.slice(1, -1)
      : address,
  );

  if (version === 4) {
    const parsed =
      parseIpv4(address);
    return (
      !parsed
      || ipv4SpecialUse(parsed)
    );
  }

  if (version === 6) {
    const parsed =
      parseIpv6(address);
    return (
      !parsed
      || ipv6SpecialUse(parsed)
    );
  }

  return true;
}

export type CimdResolvedAddressValidation =
  | {
      ok: true;
      addresses: readonly string[];
    }
  | {
      ok: false;
      error:
        | "empty_resolution"
        | "too_many_addresses"
        | "invalid_address"
        | "special_use_address";
      address?: string;
    };

export function validateCimdResolvedAddresses(
  addresses: readonly string[],
): CimdResolvedAddressValidation {
  if (addresses.length === 0) {
    return {
      ok: false,
      error: "empty_resolution",
    };
  }

  if (addresses.length > 16) {
    return {
      ok: false,
      error: "too_many_addresses",
    };
  }

  const unique =
    new Set<string>();

  for (const raw of addresses) {
    const address =
      raw.startsWith("[")
        && raw.endsWith("]")
        ? raw.slice(1, -1)
        : raw;

    if (isIP(address) === 0) {
      return {
        ok: false,
        error: "invalid_address",
        address: raw,
      };
    }

    if (
      isSpecialUseIpAddress(address)
    ) {
      return {
        ok: false,
        error: "special_use_address",
        address: raw,
      };
    }

    unique.add(address);
  }

  return {
    ok: true,
    addresses: Object.freeze(
      [...unique],
    ),
  };
}
