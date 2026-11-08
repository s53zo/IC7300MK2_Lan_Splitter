# Architecture

```mermaid
flowchart LR
    C1[Native Icom client] <-->|control / CI-V / audio UDP| D[Downstream sessions]
    C2[Native Icom client] <-->|control / CI-V / audio UDP| D
    CN[More native clients] <-->|control / CI-V / audio UDP| D
    D <--> B[Command and TX broker]
    B <--> U[One upstream Icom session]
    U <-->|control / CI-V / audio UDP| R[IC-7300MK2]
```

“One connection” means one logical native Icom session, comprising three UDP
channels. Adding a downstream client never opens another upstream radio session.
The three listeners and each client's stream state are owned by `NativeServer`;
`Broker` schedules commands and owns TX; `IcomSession` maintains the upstream
radio association. `Splitter` composes their lifecycle.

## Session virtualization

Each downstream control, CI-V and audio stream has its own IDs, sequence space,
keepalive state, replay history and bounded reorder state. Control performs
presence/ready negotiation, credential login, token exchange, capabilities and
media grants. The service emits both the native 80-byte status grant and the
144-byte connection-information grant expected by the local client references.

Media streams are matched to their authenticated control session using the
source IPv4 address **and the client ports supplied in its stream request**.
An IP-only match would confuse multiple programs on one host. Endpoint collisions
are rejected instead of stealing an existing association. This design targets a
local network; source-port-changing NAT traversal is outside the first version.

The service advertises only the implemented 48-kHz mono LPCM format. Negotiation
of unsupported codecs/rates fails explicitly. It does not advertise wfview's
Opus extension or resample one client's audio by changing the upstream format.

## Commands, replies and state

CI-V ACK/NG messages have no request identifier. The broker serializes upstream
transactions, writes a single reserved controller address upstream, and restores
the requesting client's controller address on the private reply. Scope frames and
unsolicited radio state are distributed to all clients rather than completing an
unrelated pending request. Frequency/mode changes produce shared state updates.
A command timeout resets the upstream association so a late ACK cannot confirm a
later client's transaction. Old queued writes and media are discarded on loss.

The physical radio has one shared configuration. Scope span/mode, audio routing,
mode and frequency changes affect every client. The splitter does not provide
per-client virtual tuning, spectrum spans, or AF/IF selections. The broker enables
scope and waveform output (`27 10`/`27 11`) upstream at startup/reconnect. Client
subscription OFF requests are handled locally, so one client cannot stop the
radio's shared scope output. Scope frames are rewritten to broadcast destination
`00`, allowing clients with different controller addresses to receive them.

## Ordered client read cache

The broker caches only validated successful replies to an explicit query
allowlist. Defaults are 100 ms for meters/ADC overflow and RX/TX/tuner state,
250 ms for public operator settings, and 50 ms for frequency/mode/VFO. Each TTL
is configurable from 0–1000 ms; zero disables its family. The global off switch
also disables coalescing. See [configuration](operations.md#client-read-cache).

Every logical read stays in the bounded FIFO and checks cache eligibility at
dispatch. Identical queued reads can share a fresh reply without crossing a
mutation barrier. Client permissions and generation are checked for each reply,
and each private reply restores that client's controller address. Cached replies
are not broadcast as new radio state.

Mutation admission, dispatch and outcome invalidate entries. Cache epochs prevent
an older in-flight reply from repopulating data after a mutation barrier.
Reconnects, lease transitions and unsolicited state notifications also invalidate
entries; scope samples do not. Internal polling, mode checks and TX release/safety
checks always perform fresh transactions. Stable internal polls may prime the
client cache, while startup/release checks neither consume nor prime it. No TX
safety decision uses cached state. Audio handling is unchanged; read caching does
not guarantee relief from audio dropouts.

## TX leases

The broker reserves TX for an accepted PTT, CW, supported automatic-TX or VOX
operation. It checks permission both when a command arrives and when it would
execute. Other clients' mutations and TX audio are discarded during that lease;
reads remain eligible. Lease-ending cleanup bypasses queued nonessential work,
invalidates replayable keying/audio and confirms the radio's TX state is receive.
CW completion uses a conservative deadline of 6 seconds per input character
at the slowest supported 6 WPM, followed by three observed receive polls. A client
may explicitly stop sooner. Voice-memory playback retains ownership until an
explicit stop or disconnect because silence does not prove a repeat loop ended.
Tuner completion uses tuner status; cleanup includes its specific stop command.

On startup/reconnect, the broker attempts CW stop, cleanup of remembered TX
initiators, PTT off and a receive-state query before accepting ordinary client
work. It then enables scope and waveform output. It does not retune or change the
mode/modulation route to make a client work. Configure radio LAN modulation and
AF/IF routing as appropriate for the clients. Readiness is a protocol check, not
proof that RF output is physically absent.

Local microphone, keyer, VOX and front-panel operations are outside software
ownership. TX-state polling blocks remote mutations when unowned TX is observed,
but cannot provide atomic interlocking with physical controls. For a predictable
shared station, avoid simultaneous physical and remote transmission control.

## Bounds and failure limits

The server uses a memory budget to admit sessions, rather than a licensed or
hardcoded client count. Replay, reorder and pending-send buffers are bounded per
stream. The broker also bounds queued commands globally and per client; overload
rejects commands rather than accumulating an unbounded backlog. Capacity depends
on the chosen budgets, packet sizes, client behavior, CPU and network bandwidth.

At a TX lease boundary, buffered downstream CI-V/audio and partial frames are
discarded. The server advances a seen-sequence watermark through buffered
reordered packets so a late gap-fill cannot revive already observed old TX data.
The native wire format has no TX-epoch identifier: a packet never previously
seen, delayed until a later lease in the same association, cannot always be
identified as old. Reconnects do create fresh associations/IDs.

A client timeout detects a missing heartbeat; unplugging a cable is not detected
instantaneously. A disconnected upstream radio cannot receive stop commands.
Likewise, process termination without graceful shutdown cannot execute cleanup.
Use radio-side timeouts and operational interlocks appropriate to the station.

See [validation](validation.md) for tested cases and gaps, and
[research](research.md) for the distinction between the official inner CI-V
commands and the reverse-engineered native LAN envelope.

Owner stop requests bypass ordinary queue saturation by cancelling that owner's
queued work and taking a bounded priority position after the in-flight reply.
A PTT-off request immediately retires queued media and blocks audio rearming; a
late PTT-on acknowledgement cannot undo that stop. Reply correlation still
requires consuming the current transaction or resetting on timeout.

Cleanup is mode-aware: it releases PTT, queries the actual mode, and requires CW
keyer stop only in CW/CW-R. The physical MK2 rejects CW-stop in other modes. A
failed mode read or rejected stop in CW prevents readiness/handover instead of
being treated as a successful release. The operator's mode is not changed.

## Audit follow-up safeguards

Safety polls bind their results to the owner/trigger incarnation sampled when the
query began. A queued start, restart or trigger change invalidates earlier poll
continuations even when the same client remains owner. Tuner completion requires
an acknowledged active trigger, a finite start time, elapsed startup grace and a
matching incarnation after its follow-up status query.

Bare tuning-step (`10`), attenuator (`11`) and RX-antenna (`12`) getters are reads,
not mutation barriers; their setters remain barriers. Bare `12` has a fixed `00`
field in its reply before the antenna boolean. Scope reference values are
validated in 0.5-dB steps.

Read-cache coherence instrumentation distinguishes future mutation admission
from actual state-changing dispatch/outcome, notifications and lifecycle changes.
It only counts possible queued-result sharing; delivery still obeys the original
mutation epochs, FIFO and TTL checks. No selective invalidation, cached-read
shortcut or audio recovery/pacing change is enabled by this instrumentation.

## Local interfaces

`src/app/controller.js` owns a single in-process Splitter for either interface.
Its schema validates every public CLI setting; protected persistence keeps saved
values separate from the active service until explicit reconnect. Normal close
fences new work and uses the broker's existing release/shutdown path. Owner,
observed TX and queued/pending initiators govern confirmation; actual displayed
RX/TX comes from fresh observed radio state, with ownership reported separately.
App-directory and radio-control-endpoint loopback mutexes prevent duplicate local
profiles from opening competing sessions. Older releases do not share this lock.

Desktop runs local packaged HTML in an isolated, sandboxed Electron renderer.
A narrow main-process IPC allowlist validates the owning top-level local frame;
there is no HTTP management listener or remote page. Its credential adapter uses
native asynchronous safeStorage encryption. Linux uses the same controller from
a built-in readline/ANSI terminal interface, with an explicitly owner-only,
unencrypted credential file. Metrics/history are bounded session memory, not a
persistent monitoring database. Existing heartbeat replies provide ping RTT;
reading the interface creates no additional radio probes or upstream session.
