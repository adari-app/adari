// The capture run's machine seen for the first time.
// Every snapshot ends at its host key, as a real first connection now does: a
// fixed ed25519 key (the iPhone app's fixture key, SHA256:HQKPG+aLKrfK44cuT+
// BFQWiL+yqeXHLlqG11jhKEOaw), nothing pinned and nothing sent. Only the
// capture run adds it, at step 97, after every other capture; it answers
// nothing else.

import type { HerdrHostBackend } from "../herdr/backend";
import { NewHostKeyError, openSSHFingerprint, sshHostKeyFingerprintSHA256 } from "../herdr/host-key-pinning";
import type { HostDescriptor } from "../hosts";

const wireKey = Buffer.from("AAAAC3NzaC1lZDI1NTE5AAAAIHYJpYbLpm7yFkFjzlh/JM4E+tK42rrZ0QOrWdx/vzSV", "base64");
const address = "studio-mac.local";

export const newKeyHost: HostDescriptor = {
  id: "demo-new-key",
  name: "Studio Mac",
  kind: "ssh",
  address: `robin@${address}:22`,
  platform: null,
};

export function newKeyBackend(): HerdrHostBackend {
  const refuse = (): Promise<never> =>
    Promise.reject(new NewHostKeyError(address, 22, sshHostKeyFingerprintSHA256(wireKey), openSSHFingerprint(wireKey), "ssh-ed25519"));
  return {
    kind: "demo",
    snapshot: refuse,
    sendInput: refuse,
    prompt: refuse,
    sendText: refuse,
    agentKeys: refuse,
    transcripts: () => null,
    openTerminal: refuse,
    close: () => undefined,
  };
}
