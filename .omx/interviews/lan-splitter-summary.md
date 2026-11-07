# Requirements interview

- Round 1: any client. one connection to the radio, many connection to the splitter
- Round 2: Shared control; tuning in arrival order; one TX client at a time.
- Round 3: Discard non-owner setting changes during TX; do not queue.
- Round 4: On transmitting-client disconnect/heartbeat timeout release PTT/CW, discard pending TX data, and allow another transmitter.
- Round 5: Native Icom LAN only; other interfaces deferred.
- Round 6: Linux, macOS, and Windows.
- Round 7: Local network only; no direct public Internet requirement.
- Round 8: Downstream clients use the same username/password configured on the radio.
- Round 9: Distribute RX audio and scope to every client, including clients on the same host.
- Round 10: Agent may choose implementation language, architecture and necessary dependencies.
- Round 11: Yes to hardware receive/control and brief dummy-load transmit validation; hardware address and test readiness must be established.
- Round 12: Radio credentials supplied in conversation; password intentionally excluded from persisted artifacts.

Password omitted intentionally. See ../specs/deep-interview-lan-splitter.md.
