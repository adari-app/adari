// The capture run's host-key steps. 97 adds the
// machine seen for the first time (main's `ask`) and shows the question; 98
// presses the dialog's Cancel. The capture machine's every snapshot ends at
// its fixed host key (the iPhone app's fixture key), with nothing pinned.

import { describe, expect, it } from "vitest";

import { hostKeyCaptureSteps } from "../src/main/capture";
import { newKeyBackend, newKeyHost } from "../src/main/demo/demo-new-key";
import { NewHostKeyError } from "../src/main/herdr/host-key-pinning";
import { HostRegistry } from "../src/main/hosts";

describe("the host-key captures", () => {
  it("97 asks through main's hook, 98 presses Cancel (never Trust)", () => {
    const ask = async (): Promise<void> => undefined;
    const steps = hostKeyCaptureSteps(newKeyHost.id, ask);
    expect(steps.map((step) => step.name)).toEqual(["97-host-key-question", "98-host-key-cancelled"]);
    expect(steps[0]!.before).toBe(ask);
    expect(steps[1]!.before).toBeUndefined();
    expect(steps[1]!.commands).toEqual([{ type: "click", selector: ".dlg.hostkey .df .btn:not(.pri)" }]);
    expect(steps[1]!.page?.join("")).toContain(`.host[data-host=\\"demo-new-key\\"]`);
  });

  it("the capture machine's snapshot ends at its new host key; the registry holds the question", async () => {
    await expect(newKeyBackend().snapshot()).rejects.toBeInstanceOf(NewHostKeyError);
    const registry = new HostRegistry(() => undefined);
    registry.add(newKeyHost, newKeyBackend());
    await registry.refresh(newKeyHost.id);
    const asked = registry.list()[0]?.hostKey;
    expect(asked).toEqual({
      id: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u),
      host: "studio-mac.local",
      port: 22,
      keyType: "ssh-ed25519",
      typeLabel: "ED25519",
      fingerprint: "SHA256:HQKPG+aLKrfK44cuT+BFQWiL+yqeXHLlqG11jhKEOaw",
      check: "ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub",
    });
    registry.cancelHostKey(newKeyHost.id, asked!.id);
    expect(registry.list()[0]?.hostKeyDeclined).toBe(true);
    registry.close();
  });
});
