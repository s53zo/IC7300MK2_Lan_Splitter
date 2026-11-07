# Protocol research and provenance

Research date: 2026-11-07. Public project discovery is a source map, not an
exhaustive claim to have found every implementation or verified every advertised
radio. A project's support claim does not establish interoperability with this
splitter. See [validation](validation.md) for executed tests.

## Official Icom material

| Source | Relevant evidence |
| --- | --- |
| [MK2 Basic Manual](https://www.icomjapan.com/support/manual/4459/) ([Icom UK PDF](https://icomuk.co.uk/files/icom/PDF/productManual/IC-7300MK2_ENG_Basic_0.pdf)) | Network settings, LAN AF/12-kHz IF output, LAN MOD input, network user registrations; UDP control/serial/audio defaults 50001/50002/50003 on pp57–60 |
| [MK2 Advanced Manual](https://www.icomjapan.com/support/manual/4487/) ([Icom UK PDF](https://icomuk.co.uk/files/icom/PDF/advancedManuals/IC-7300MK2_ENG_Advanced_0.pdf)) | Operating and connection context; not a complete LAN wire specification |
| [MK2 CI-V Reference](https://www.icomjapan.com/support/manual/4486/) ([Icom UK PDF](https://icomuk.co.uk/files/icom/PDF/productAdditionalFile/IC-7300MK2_ENG_CI-V_0.pdf)) | Default B6 address, control command tables, LAN routing parameters and 475-point scope payload; scope enable and waveform output are separate commands |
| [RS-BA1 Version 2 Manual](https://www.icomeurope.com/wp-content/uploads/2022/12/RS-BA1_Ver2_ENG_IM_4.pdf) | Printed pp5-11 and 7-2 describe occupied-radio behavior and disconnecting before another operator connects; this edition predates MK2 |

The two user slots in the MK2 menu are credential registrations, not proof of
two simultaneous operating sessions. One upstream session is a project
requirement based on the owner's observed hardware limitation. The network uses
UDP despite the broader term “TCP/IP.” Inner CI-V command documentation does not
specify the complete authentication/session/audio envelope.

## Local implementation evidence

The reviewed sibling revisions are:

| Checkout | Revision | Relevance |
| --- | --- | --- |
| `../piro-lan-pr` | `102da1af2f1829e8a069aa227e1c738f6f6f339c` | Native LAN packet, stream, session and audio primitives; deterministic fixtures; recorded MK2 hardware validation |
| `../wfweb` | `399ee52253bb109b221dcc36c50d607be378c154` | Native Icom client and server; packet layouts, grant messages, capability advertisement and media fanout |
| `../piro` | Main checkout reviewed separately | Does not contain the LAN implementation found in `piro-lan-pr` |
| `../wfview` | Additional local protocol reference | Upstream client/server context; no new hardware proof inferred from its presence |

PiRO upstream is https://github.com/StevPem/piro; the studied LAN fork is
https://github.com/s53zo/piro. wfweb upstream is https://github.com/adecarolis/wfweb
and the studied fork is https://github.com/s53zo/wfweb.

PiRO's `src/icom-lan/{protocol,stream,session,audio}.js` form the upstream transport
starting point. Its recorded physical tests are in
`docs/icom-lan-hardware-validation.md`; those records belong to PiRO and do not
prove this splitter works on hardware. Its protocol source notes pin AetherSDR
`e8548d7ed5a410f0d4b7faf94a7b5e932d64104f` and wfview
`098568546731aff25c7e9ea93c0f009eeee19137` as earlier cross-checks.

The wfweb sources `include/packettypes.h`, `src/radio/icomudphandler.cpp` and
`src/radio/icomserver.cpp` establish downstream packet shapes. Its server's
IP-based media association and shared audio configuration were not suitable for
same-host, independent multi-client sessions without redesign. Its native server
also has assumptions about the current streaming client. Existing source is
reference evidence, not a verified unrestricted splitter.

The tests' synthetic radio is adapted from PiRO's independently encoded fixture;
it does not import production packet builders. Literal packet vectors separately
pin offsets and endianness. This provides useful independent evidence but is not
a substitute for third-party application or physical radio testing.

## Online implementation and documentation map

| Project | Why it matters | Evidence boundary |
| --- | --- | --- |
| [wfview](https://github.com/wf-group/wfview), [GitLab upstream](https://gitlab.com/eliggett/wfview) | Mature native Icom client/server implementation | Its [FAQ](https://wfview.org/wfview-user-manual/faq/) identifies the OEM network protocol as undocumented and credits the reverse-engineering lineage |
| [AetherSDR](https://github.com/aethersdr/AetherSDR) | MK2 protocol/session/audio/scheduler backend and tests | Examine model-specific behavior and [TX continuity issue 6169](https://github.com/aethersdr/AetherSDR/issues/6169); an issue report is not a universal radio limitation |
| [kappanhang](https://github.com/nonoo/kappanhang) | Foundational Go implementation of Icom network audio/serial transport | Related-Icom protocol evidence; no MK2 physical validation inferred |
| [NetworkIcom](https://github.com/microenh/NetworkIcom) | Swift implementation and RS-BA1 packet analysis | Targets IC-7610; useful transport evidence, not MK2 hardware proof |
| [rigplane-core](https://github.com/rigplane/rigplane-core) | Python native LAN implementation, formerly `morozsm/icom-lan` | README lists MK2 LAN; splitter interoperability remains a separate test |
| [Radio WebOp](https://github.com/Dreikor17/radio-webop) | Web control with native LAN backend and MK2 profile | Candidate client/reference; profile presence is not an executed test |
| [sdroxide](https://github.com/dividebysandwich/sdroxide) | Rust native Icom LAN backend, including advertised MK2 support | Candidate client/reference; its own UI streaming is distinct from a native multi-client splitter |
| [Rafe protocol notes](https://patrick.lidstone.net/wiki/rsba1-protocol/), [standalone server notes](https://patrick.lidstone.net/wiki/rsba1server/) | Documents client/server packet structures and a simulator backend | Independent implementation notes cross-checked against wfview/kappanhang; not official Icom specifications |
| [CardSat protocol notes](https://github.com/prstoetzer/CardSat/blob/main/docs/interfaces/ICOM_LAN_PROTOCOL.md) | Additional native packet-layout reference | IC-9700 implementation context |
| [WIFILT](https://github.com/ok1hra/wifilt/blob/main/SOFTWARE.md) | Related native Icom application | Its documentation distinguishes expected MK2 compatibility from physical verification |
| [mrrc_ft710](https://github.com/cheenle/mrrc_ft710) | Leads to related `mrrc_modern` MK2 work | Transport details require separate verification |
| [Hamlib MK2 issue 1975](https://github.com/Hamlib/Hamlib/issues/1975) | Illustrates changed default CI-V address and RS-BA1 virtual-COM use | Virtual COM through RS-BA1 is not proof of direct native LAN support |

## Licensing

PiRO is AGPL-3.0-only. Its packet primitives derive in part from AetherSDR GPL-3.0
sources, with wfview and kappanhang protocol lineage. Original notices, GPL text
and project attribution are preserved; see [NOTICE.md](../NOTICE.md). This project
is AGPL-3.0-only. Manuals remain external links and are not redistributed.
