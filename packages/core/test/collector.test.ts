import { describe, expect, it } from 'vitest';
import { TargetCollector } from '../src/collector';
import { RidgePoly2Model } from '../src/model';
import { calibrationTargets, seededRng, validationTargets } from '../src/geometry';
import { syntheticFrame } from './helpers';

const W = 1280, H = 720;

describe('TargetCollector', () => {
  it('ignores the settle window, caps frames and reports insufficient targets', () => {
    const c = new TargetCollector({ settleMs: 300, maxFrames: 5, minFrames: 3 });
    c.show(0, 100, 100, 1000);
    expect(c.addFrame(syntheticFrame(100, 100, W, H), 1100, false)).toBe(0); // settling
    for (let i = 0; i < 10; i++) c.addFrame(syntheticFrame(100, 100, W, H), 1400 + i * 33, false);
    expect(c.count(0)).toBe(5);
    c.finish(0);
    expect(c.samples().filter((s) => s.pointIndex === 0)).toHaveLength(5);
    c.show(1, 500, 500, 3000);
    c.addFrame(syntheticFrame(500, 500, W, H), 3400, false);
    c.addFrame(null, 3433, false);
    c.addFrame(syntheticFrame(500, 500, W, H), 3466, true); // blink
    c.finish(1);
    expect(c.insufficient()).toEqual([1]);
    expect(c.samples()).toHaveLength(6);
  });

  it('runs a full calibrate → validate cycle on synthetic data', () => {
    const rng = seededRng(21);
    const cal = new TargetCollector();
    let t = 0;
    for (const tg of calibrationTargets(9, { w: W, h: H })) {
      cal.show(tg.index, tg.vx, tg.vy, t);
      for (let k = 0; k < 40; k++, t += 33) cal.addFrame(syntheticFrame(tg.vx, tg.vy, W, H, rng), t, false);
      cal.finish(tg.index);
      t += 200;
    }
    expect(cal.insufficient()).toEqual([]);
    const fit = RidgePoly2Model.fit(cal.samples());

    const val = new TargetCollector();
    for (const tg of validationTargets({ w: W, h: H })) {
      val.show(tg.index, tg.vx, tg.vy, t);
      for (let k = 0; k < 40; k++, t += 33) val.addFrame(syntheticFrame(tg.vx, tg.vy, W, H, rng), t, false);
      val.finish(tg.index);
    }
    const result = val.evaluate(fit.model, 100, 150);
    expect(result.perPoint).toHaveLength(4);
    expect(result.meanErrPx).toBeLessThan(60);
    expect(result.verdict).toBe('pass');
    expect(Math.abs(result.biasX)).toBeLessThan(40);
  });
});
