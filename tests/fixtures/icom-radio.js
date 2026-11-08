'use strict';

// SPDX-License-Identifier: AGPL-3.0-only
// Adapted from PiRO test/fixtures/icom-lan-peer.js, S53ZO and contributors.
// Source checkout revision 102da1af2f1829e8a069aa227e1c738f6f6f339c.

// Synthetic radio, independently specified from wfview packettypes.h and the
// IC-7300MK2 CI-V guide. This file deliberately imports NO production packet
// encoders, parsers or constants. These are not hardware captures.
const dgram = require('node:dgram');
const { EventEmitter } = require('node:events');

function envelope(length, type, sender, receiver, seq = 0) {
  const p = Buffer.alloc(length);
  p.writeUInt32LE(length, 0);
  p.writeUInt16LE(type, 4);
  p.writeUInt16LE(seq & 65535, 6);
  p.writeUInt32BE(sender >>> 0, 8);
  p.writeUInt32BE(receiver >>> 0, 12);
  return p;
}

class IcomPeer extends EventEmitter {
  constructor(options = {}) {
    super();
    this.options = options;
    this.sockets = {};
    this.associations = {};
    this.received = [];
    this.commands = [];
    this.txAudio = [];
    this.renewals = [];
    this.timers = new Set();
    this.ptt = false;
    this.mode = 1;
    this.dataMode = false;
    this.filter = 1;
    this.otherFrequency = Buffer.from('0000000700', 'hex');
    this.otherMode = 0;
    this.otherDataMode = false;
    this.otherFilter = 1;
    this.settings = new Map();
    this.frequency = Buffer.from('0040071400', 'hex'); // 14.074 MHz, independent BCD bytes.
    this.parameters = new Map([['0079', Buffer.from([1])], ['0080', Buffer.from([1])],
      ['0083', Buffer.from([1, 0x28])], ['0084', Buffer.from([0])], ['0085', Buffer.from([1])]]);
    this.keySpeed = Buffer.from([0, 0x84]); // Canonical 20 WPM per PiRO key-speed table.
    this.breakIn = 0;
    this.cwText = [];
    this.cwBusy = options.cwBusy ?? 0;
    this.nextSid = 0x10203040;
    this.connections = { control: 0, civ: 0, audio: 0 };
    this.address = options.address ?? 0xb6;
    this.radioId = Buffer.from('00112233445566778899aabbccddeeff', 'hex');
  }

  async start() {
    for (const role of ['control', 'civ', 'audio']) {
      const socket = this.sockets[role] = dgram.createSocket('udp4');
      socket.on('message', (p, remote) => this.receive(role, p, remote));
      await new Promise((resolve) => socket.bind(0, '127.0.0.1', resolve));
    }
    return this;
  }

  config(overrides = {}) {
    return { host: '127.0.0.1', controlPort: this.sockets.control.address().port,
      civPort: this.sockets.civ.address().port, audioPort: this.sockets.audio.address().port,
      username: 'beer', password: 'beer', timeoutMs: 1500, reconnectAttempts: 0, ...overrides };
  }

  schedule(fn, ms) {
    const timer = setTimeout(() => { this.timers.delete(timer); fn(); }, ms);
    this.timers.add(timer);
  }

  receive(role, p, remote) {
    if (p.length < 16 || this.options.silent) return;
    const type = p.readUInt16LE(4);
    const sender = p.readUInt32BE(8);
    let a = this.associations[role];
    this.received.push({ role, packet: Buffer.from(p), at: performance.now() });
    if (type === 3) {
      if (!a || a.client !== sender || a.port !== remote.port) {
        this.connections[role]++;
        a = this.associations[role] = { sid: this.nextSid++, client: sender, port: remote.port,
          seq: 1, seen: new Set(), history: new Map() };
      }
      this.sendRaw(role, envelope(16, 4, a.sid, a.client), a);
      return;
    }
    if (!a || sender !== a.client || p.readUInt32BE(12) !== a.sid) return;
    if (type === 6) { this.sendRaw(role, envelope(16, 6, a.sid, a.client, 1), a); return; }
    if (type === 7 && p.length === 21 && !p[16]) {
      const reply = envelope(21, 7, a.sid, a.client, p.readUInt16LE(6));
      reply[16] = 1;
      p.copy(reply, 17, 17, 21);
      this.sendRaw(role, reply, a);
      return;
    }
    if (type === 1) {
      const old = a.history.get(p.readUInt16LE(6));
      if (old && !this.options.dropRetransmits) this.sendRaw(role, old, a);
      return;
    }
    if (type !== 0) return;
    const seq = p.readUInt16LE(6);
    if (a.seen.has(seq)) return;
    a.seen.add(seq);
    if (a.seen.size > 512) a.seen.delete(a.seen.values().next().value);
    if (role === 'control') this.control(p, a);
    if (role === 'civ' && p[16] === 0xc1 && p.length > 21) this.civ(p.subarray(21), a);
    if (role === 'audio' && p.length > 24) {
      this.txAudio.push({ bytes: Buffer.from(p.subarray(24)), inner: p.readUInt16BE(18),
        outer: seq, at: performance.now() });
      this.emit('tx-audio');
    }
  }

  sendRaw(role, p, a = this.associations[role]) {
    if (a && this.sockets[role]) this.sockets[role].send(p, a.port, '127.0.0.1');
  }

  tracked(role, p, a = this.associations[role], { drop = false, delay = 0 } = {}) {
    p.writeUInt16LE(a.seq++ & 65535, 6);
    if (role === 'control' && this.options.unsequencedControl) p.writeUInt16LE(0, 6);
    a.history.set(p.readUInt16LE(6), Buffer.from(p));
    while (a.history.size > 512) a.history.delete(a.history.keys().next().value);
    if (!drop) {
      if (delay) this.schedule(() => this.sendRaw(role, p, a), delay);
      else this.sendRaw(role, p, a);
    }
    return p;
  }

  control(p, a) {
    if (p.length === 128) {
      const reply = envelope(96, 0, a.sid, a.client);
      a.authId = Buffer.from('000011223344', 'hex');
      p.copy(a.authId, 0, 26, 28);
      a.authId.copy(reply, 26);
      // Independent reference vector from AetherSDR testPasscode: "beer".
      const credential = Buffer.from('2b3f555c000000000000000000000000', 'hex');
      if (this.options.rejectLogin || !p.subarray(64, 80).equals(credential) || !p.subarray(80, 96).equals(this.options.passwordVector || credential)) reply.writeUInt32BE(0xfffffffe, 48);
      this.tracked('control', reply, a);
      const caps = envelope(168, 0, a.sid, a.client);
      this.radioId.copy(caps, 66);
      caps.write('Shack MK2', 82, 'ascii'); // deliberately not the model name.
      caps[148] = this.address;
      this.tracked('control', caps, a);
    } else if (p.length === 64 && p[21] === 5) {
      const seq = p.readUInt16BE(22);
      this.renewals.push(seq);
      if (this.options.ignoreRenewals && this.renewals.length > 1) return;
      const reply = envelope(64, 0, a.sid, a.client);
      reply.writeUInt32BE(48, 16);
      reply[20] = 2;
      reply[21] = 5;
      reply.writeUInt16BE(seq, 22);
      a.authId.copy(reply, 26);
      if (this.options.rejectRenewal && this.renewals.length > 1) reply.writeUInt32LE(0xffffffff, 48);
      this.tracked('control', reply, a);
    } else if (p.length === 144 && p[21] === 3) {
      this.streamRequest = Buffer.from(p);
      const grant = envelope(144, 0, a.sid, a.client);
      grant[20] = 3;
      grant[21] = 0;
      a.authId.copy(grant, 26);
      this.radioId.copy(grant, 32);
      grant[96] = 1;
      this.tracked('control', grant, a);
    }
  }

  replyCiv(bytes, a = this.associations.civ, fault) {
    const frame = Buffer.concat([Buffer.from([0xfe, 0xfe, 0xe0, this.address]), Buffer.from(bytes), Buffer.from([0xfd])]);
    const p = envelope(21 + frame.length, 0, a.sid, a.client);
    p[16] = 0xc1;
    p.writeUInt16LE(frame.length, 17);
    p.writeUInt16BE(a.seq & 65535, 19);
    frame.copy(p, 21);
    return this.tracked('civ', p, a, fault);
  }

  civ(frame, a) {
    if (frame.length < 6 || frame[0] !== 0xfe || frame[1] !== 0xfe || frame.at(-1) !== 0xfd) return;
    const cmd = frame[4], bytes = frame.subarray(5, -1);
    this.commands.push(Buffer.from(frame));
    this.emit('command', frame);
    let response = [0xfb];
    if (cmd === 0x19) response = [cmd, 0, this.options.modelId ?? 0xb6];
    else if (cmd === 3) response = Buffer.concat([Buffer.from([3]), this.frequency]);
    else if (cmd === 4) response = [4, this.mode, this.filter];
    else if (cmd === 5) this.frequency = Buffer.from(bytes);
    else if (cmd === 6) { this.mode = bytes[0]; this.dataMode = false; this.filter = bytes[1] ?? this.filter; }
    else if (cmd === 0x25) {
      const other = bytes[0] === 1;
      if (bytes.length === 1) response = Buffer.concat([Buffer.from([cmd, bytes[0]]), other ? this.otherFrequency : this.frequency]);
      else if (bytes.length === 6) {
        if (other) this.otherFrequency = Buffer.from(bytes.subarray(1));
        else this.frequency = Buffer.from(bytes.subarray(1));
      } else response = [0xfa];
    } else if (cmd === 0x26) {
      const other = bytes[0] === 1;
      if (bytes.length === 1) response = [cmd, bytes[0], other ? this.otherMode : this.mode,
        (other ? this.otherDataMode : this.dataMode) ? 1 : 0, other ? this.otherFilter : this.filter];
      else if (bytes.length === 4) {
        if (other) { this.otherMode = bytes[1]; this.otherDataMode = Boolean(bytes[2]); this.otherFilter = bytes[3]; }
        else { this.mode = bytes[1]; this.dataMode = Boolean(bytes[2]); this.filter = bytes[3]; }
      } else response = [0xfa];
    }
    else if (cmd === 0x1a && bytes[0] === 5) {
      const key = bytes.subarray(1, 3).toString('hex');
      if (bytes.length > 3) this.parameters.set(key, Buffer.from(bytes.subarray(3)));
      else response = Buffer.concat([Buffer.from([cmd, 5]), bytes.subarray(1, 3), this.parameters.get(key) || Buffer.from([0])]);
    } else if (cmd === 0x1a && bytes[0] === 6) {
      if (bytes.length > 1) this.dataMode = Boolean(bytes[1]);
      else response = [cmd, 6, this.dataMode ? 1 : 0, 1];
    } else if (cmd === 0x1c && bytes[0] === 0) {
      if (bytes.length > 1) this.ptt = Boolean(bytes[1]);
      else response = [cmd, 0, this.ptt ? 1 : 0];
    } else if (cmd === 0x1c && bytes[0] === 1) {
      // MK2 CI-V reference: 1C 01 reads tuner status; data 00=OFF,
      // 01=ON, 02=Tune. A read returns data, never a generic ACK.
      if (bytes.length === 1) response = [cmd, 1, this.settings.get('tuner') ?? 0];
      else this.settings.set('tuner', bytes[1]);
    } else if (cmd === 0x0f) {
      if (!bytes.length) response = [cmd, this.settings.get('split') ?? 0];
      else this.settings.set('split', bytes[0]);
    } else if (cmd === 0x10 || cmd === 0x11) {
      // MK2 starred getters are bare commands; setters append one value byte.
      const valid = cmd === 0x10 ? bytes[0] <= 8 : bytes[0] === 0 || bytes[0] === 0x20;
      if (!bytes.length) response = [cmd, this.settings.get(cmd) ?? 0];
      else if (bytes.length === 1 && valid) this.settings.set(cmd, bytes[0]);
      else response = [0xfa];
    } else if (cmd === 0x12) {
      // A bare getter returns fixed subcommand 00 followed by RX antenna state.
      if (!bytes.length) response = [cmd, 0, this.settings.get('rx-antenna') ?? 0];
      else if (bytes.length === 2 && bytes[0] === 0 && bytes[1] <= 1) this.settings.set('rx-antenna', bytes[1]);
      else response = [0xfa];
    } else if (cmd === 0x1a && [3, 4].includes(bytes[0])) {
      const key = `1a${bytes[0]}`;
      if (bytes.length === 1) response = [cmd, bytes[0], this.settings.get(key) ?? 0];
      else this.settings.set(key, bytes[1]);
    } else if (cmd === 0x27 && [0x14, 0x15, 0x16, 0x17, 0x19, 0x1a].includes(bytes[0]) && bytes[1] === 0) {
      // MK2 scope getters carry a main-scope selector before their value.
      // A getter has no value bytes; a setter appends the selected value.
      const key = `scope-${bytes[0]}`;
      const defaults = { 20: [0], 21: [0, 0, 5, 0, 0], 22: [1], 23: [0], 25: [0, 0, 0], 26: [0] };
      if (bytes.length === 2) response = [cmd, bytes[0], 0, ...(this.settings.get(key) || defaults[bytes[0]])];
      else this.settings.set(key, [...bytes.subarray(2)]);
    } else if (cmd === 0x27 && bytes[0] !== 0) {
      const key = `27${bytes[0]}`;
      if (bytes.length === 1) response = [cmd, bytes[0], this.settings.get(key) ?? 0];
      else this.settings.set(key, bytes[1]);
    } else if (cmd === 0x14 && bytes[0] !== 0x0c) {
      const key = `14${bytes[0]}`;
      if (bytes.length === 1) response = [cmd, bytes[0], ...(this.settings.get(key) || [0, 0x50])];
      else this.settings.set(key, [...bytes.subarray(1)]);
    } else if (cmd === 0x14 && bytes[0] === 0x0c) {
      if (bytes.length > 1) this.keySpeed = Buffer.from(bytes.subarray(1));
      else response = Buffer.concat([Buffer.from([cmd, 0x0c]), this.keySpeed]);
    } else if (cmd === 0x16 && bytes[0] === 0x47) {
      if (bytes.length > 1) this.breakIn = bytes[1];
      else response = [cmd, 0x47, this.breakIn];
    } else if (cmd === 0x17) {
      if (bytes[0] === 0xff) { this.ptt = false; this.cwStopped = true; }
      else if (this.cwBusy-- > 0) response = [0xfa];
      else {
        this.cwText.push(bytes.toString('ascii'));
        this.ptt = true;
        this.schedule(() => { this.ptt = false; }, 30);
      }
    } else if (cmd === 0x15) response = bytes[0] === 7 ? [cmd, 7, 0] : [cmd, bytes[0], 0, 0x50];
    else if (cmd === 0x16 && bytes.length === 1) response = [cmd, bytes[0], 0];
    let fault;
    if (this.options.dropNextReply) { this.options.dropNextReply = false; fault = { drop: true }; }
    if (this.options.delayNextReply) { fault = { delay: this.options.delayNextReply }; this.options.delayNextReply = 0; }
    this.replyCiv(response, a, fault);
  }

  rxAudio(pcm, fault) {
    const a = this.associations.audio;
    const p = envelope(24 + pcm.length, 0, a.sid, a.client);
    p.writeUInt16BE(0x8000, 16);
    p.writeUInt16BE(a.seq & 65535, 18);
    p.writeUInt16BE(pcm.length, 22);
    pcm.copy(p, 24);
    return this.tracked('audio', p, a, fault);
  }

  // A complete MK2 LAN scope division: header 15 bytes + 475 amplitudes.
  scope(values = Buffer.alloc(475, 42), fault) {
    if (values.length !== 475) throw new Error('Expected 475 scope samples');
    const data = Buffer.alloc(15);
    data[1] = 1; // division one
    data[2] = 1; // one division maximum
    const frame = Buffer.concat([Buffer.from([0xfe, 0xfe, 0x00, this.address, 0x27, 0x00]), data, values, Buffer.from([0xfd])]);
    return this.rawCiv(frame, fault);
  }

  rawCiv(frame, fault) {
    const a = this.associations.civ;
    const p = envelope(21 + frame.length, 0, a.sid, a.client);
    p[16] = 0xc1;
    p.writeUInt16LE(frame.length, 17);
    p.writeUInt16BE(a.seq & 65535, 19);
    frame.copy(p, 21);
    return this.tracked('civ', p, a, fault);
  }

  release() {
    const a = this.associations.control;
    const p = envelope(144, 0, a.sid, a.client);
    p.writeUInt32BE(128, 16);
    p[20] = 3;
    a.authId.copy(p, 26);
    this.radioId.copy(p, 32);
    this.tracked('control', p, a);
  }

  async close() {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    await Promise.all(Object.values(this.sockets).map((s) => new Promise((resolve) => s.close(resolve))));
    this.sockets = {};
  }
}

module.exports = { IcomPeer, envelope };
