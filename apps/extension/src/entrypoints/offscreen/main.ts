/**
 * Offscreen document bootstrap: owns the camera + gaze engine and talks to
 * the service worker over the engine port.
 */
import { PORT_ENGINE, type EngineToSw, type SwToEngine } from '@red-tracking/protocol';
import { GazeEngine, type LandmarkSource } from '../../lib/gaze-engine';
import { FakeLandmarkSource } from '../../lib/fake-camera';
import { RealLandmarkSource } from '../../lib/real-source';
import { connectPort } from '../../lib/ports';

const params = new URLSearchParams(location.search);
const forceFake = params.get('fake') === '1';

let engine: GazeEngine;
const port = connectPort<EngineToSw, SwToEngine>(PORT_ENGINE, {
  onMessage: (msg) => void handle(msg),
  onConnect: () => {
    // Re-announce status after a SW restart so the panel snapshot is fresh.
    if (engine) port.post({ type: 'ENGINE_STATUS', status: engine.getStatus() });
  },
});
engine = new GazeEngine((m) => port.post(m));

let starting: Promise<void> | null = null;

async function handle(msg: SwToEngine): Promise<void> {
  switch (msg.type) {
    case 'ENGINE_START': {
      if (starting) await starting.catch(() => undefined);
      starting = startEngine(msg.deviceId, forceFake || !!msg.fake);
      await starting.catch((err) => console.error('[rt:offscreen] engine start failed', err));
      starting = null;
      break;
    }
    case 'ENGINE_STOP':
      engine.stop();
      break;
    default:
      engine.handle(msg);
  }
}

async function startEngine(deviceId: string | undefined, fake: boolean): Promise<void> {
  let source: LandmarkSource;
  if (fake) {
    source = new FakeLandmarkSource();
    await engine.start(source, 'fake', 0);
    return;
  }
  // 720p gives the landmark model a larger face crop → noticeably steadier iris points.
  source = new RealLandmarkSource({ deviceId, width: 1280, height: 720 }, (h) => engine.updateDelegate(h.delegate, h.loadMs));
  await engine.start(source, 'GPU');
}

// Keep the service worker alive while we run (port traffic resets its idle timer).
setInterval(() => port.post({ type: 'PING' }), 20_000);
