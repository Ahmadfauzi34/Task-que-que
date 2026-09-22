import {
  describe,
  expect,
  test,
} from "bun:test";

import {
  isSpecialUseIpAddress,
  validateCimdResolvedAddresses,
} from "../src/oauth-cimd-network";

describe(
  "CIMD network destination policy",
  () => {
    test(
      "accepts ordinary public IPv4 and IPv6 addresses",
      () => {
        expect(
          isSpecialUseIpAddress(
            "93.184.216.34",
          ),
        ).toBe(false);

        expect(
          isSpecialUseIpAddress(
            "8.8.8.8",
          ),
        ).toBe(false);

        expect(
          isSpecialUseIpAddress(
            "2606:4700:4700::1111",
          ),
        ).toBe(false);
      },
    );

    test(
      "rejects loopback, private, link-local, documentation, multicast, and reserved IPv4",
      () => {
        for (
          const address
          of [
            "0.0.0.0",
            "10.0.0.1",
            "100.64.0.1",
            "127.0.0.1",
            "169.254.1.1",
            "172.16.0.1",
            "192.0.0.1",
            "192.0.2.1",
            "192.168.1.1",
            "198.18.0.1",
            "198.51.100.1",
            "203.0.113.1",
            "224.0.0.1",
            "255.255.255.255",
          ]
        ) {
          expect(
            isSpecialUseIpAddress(
              address,
            ),
          ).toBe(true);
        }
      },
    );

    test(
      "rejects special-use IPv6 ranges and mapped addresses",
      () => {
        for (
          const address
          of [
            "::",
            "::1",
            "::ffff:8.8.8.8",
            "64:ff9b::1",
            "100::1",
            "2001::1",
            "2001:db8::1",
            "2002::1",
            "3fff::1",
            "fc00::1",
            "fe80::1",
            "ff02::1",
          ]
        ) {
          expect(
            isSpecialUseIpAddress(
              address,
            ),
          ).toBe(true);
        }
      },
    );

    test(
      "requires a bounded all-public DNS result set",
      () => {
        expect(
          validateCimdResolvedAddresses(
            [],
          ),
        ).toEqual({
          ok: false,
          error:
            "empty_resolution",
        });

        expect(
          validateCimdResolvedAddresses([
            "93.184.216.34",
            "127.0.0.1",
          ]),
        ).toEqual({
          ok: false,
          error:
            "special_use_address",
          address: "127.0.0.1",
        });

        expect(
          validateCimdResolvedAddresses([
            "not-an-ip",
          ]),
        ).toEqual({
          ok: false,
          error:
            "invalid_address",
          address: "not-an-ip",
        });

        expect(
          validateCimdResolvedAddresses([
            "93.184.216.34",
            "93.184.216.34",
            "2606:4700:4700::1111",
          ]),
        ).toEqual({
          ok: true,
          addresses: [
            "93.184.216.34",
            "2606:4700:4700::1111",
          ],
        });

        expect(
          validateCimdResolvedAddresses(
            Array.from(
              { length: 17 },
              (_, index) =>
                `8.8.8.${index + 1}`,
            ),
          ),
        ).toEqual({
          ok: false,
          error:
            "too_many_addresses",
        });
      },
    );
  },
);
