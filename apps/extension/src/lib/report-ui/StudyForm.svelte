<script lang="ts">
  import { DEFAULT_CALIBRATION, type Study } from '@red-tracking/protocol';
  import { encodeStudyCode, validateStudy } from '@red-tracking/core';
  import { i18n } from '#i18n';
  import { getDb } from '../db';
  import { uid } from '../ids';
  import { extUrl } from '../urls';

  let name = $state('');
  let targetUrl = $state('https://');
  let instructionsEs = $state('');
  let instructionsEn = $state('');
  let durationSec = $state<number | ''>('');
  let points = $state<9 | 13>(9);
  let aoiText = $state('');
  let showDot = $state(false);
  let code = $state<string | null>(null);
  let link = $state<string | null>(null);
  let error = $state<string | null>(null);
  let copied = $state<string | null>(null);

  async function generate() {
    error = null;
    try {
      const aoiSelectors = aoiText
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .map((l) => {
          const [a, b] = l.split('|').map((s) => s.trim());
          return b ? { label: a!, selector: b } : { label: a!, selector: a! };
        });
      const study: Study = validateStudy({
        v: 1,
        id: uid('st'),
        name,
        targetUrl,
        instructions: instructionsEn ? { es: instructionsEs, en: instructionsEn } : instructionsEs,
        durationSec: durationSec === '' ? undefined : Number(durationSec),
        aoiSelectors,
        calibration: { ...DEFAULT_CALIBRATION, points },
        showGazeDot: showDot,
        createdAt: Date.now(),
      });
      const db = await getDb();
      await db.put('studies', study);
      code = encodeStudyCode(study);
      link = extUrl('/onboarding.html', { study: code });
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
  }

  async function copy(text: string, which: string) {
    await navigator.clipboard.writeText(text);
    copied = which;
    setTimeout(() => (copied = null), 1500);
  }
</script>

<div class="card grid" style="max-width: 760px">
  <h2>{i18n.t('study_form.title')}</h2>
  <label>{i18n.t('study_form.name')}<input bind:value={name} /></label>
  <label>{i18n.t('study_form.target_url')}<input bind:value={targetUrl} placeholder="https://www.tienda.com/cereales" /></label>
  <label>{i18n.t('study_form.instructions')} (es)<textarea bind:value={instructionsEs}></textarea></label>
  <label>{i18n.t('study_form.instructions')} (en, opcional)<textarea bind:value={instructionsEn}></textarea></label>
  <div class="row">
    <label style="flex:1">{i18n.t('study_form.duration')}<input type="number" min="10" bind:value={durationSec} /></label>
    <label style="flex:1">{i18n.t('study_form.points')}
      <select bind:value={points}><option value={9}>9</option><option value={13}>13</option></select>
    </label>
  </div>
  <label>{i18n.t('study_form.aoi_selectors')}<textarea bind:value={aoiText} placeholder="Producto | .product-card&#10;Precio | .price"></textarea></label>
  <label class="row" style="color: var(--text)"><input type="checkbox" bind:checked={showDot} style="width:auto" /> {i18n.t('study_form.show_dot')}</label>
  <div class="row">
    <button class="primary" onclick={generate} disabled={!name || !targetUrl}>{i18n.t('study_form.generate')}</button>
    {#if error}<span style="color:#ff8c85">{error}</span>{/if}
  </div>
  {#if code}
    <label>{i18n.t('study_form.code_label')}</label>
    <code class="code">{code}</code>
    <div class="row">
      <button onclick={() => copy(code!, 'code')}>{copied === 'code' ? i18n.t('study_form.copied') : i18n.t('study_form.copy')}</button>
    </div>
    <label>{i18n.t('study_form.link_label')}</label>
    <code class="code">{link}</code>
    <div class="row">
      <button onclick={() => copy(link!, 'link')}>{copied === 'link' ? i18n.t('study_form.copied') : i18n.t('study_form.copy')}</button>
    </div>
  {/if}
</div>
