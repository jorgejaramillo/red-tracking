import { SessionController } from '../lib/sw/controller';

export default defineBackground(() => {
  // The controller registers all listeners synchronously in its constructor
  // (required so events are not missed when the service worker wakes up).
  const controller = new SessionController();
  (globalThis as unknown as { __rt: SessionController }).__rt = controller;
});
