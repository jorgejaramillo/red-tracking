<script lang="ts">
  import { i18n } from '#i18n';
  import type { Study } from '@red-tracking/protocol';
  import { isStudyCode } from '@red-tracking/core';
  import { hostnameOf, localized } from './format';

  interface Props {
    study: Study | null;
    /** Last join attempt was rejected by the service worker. */
    invalid: boolean;
    busy?: boolean;
    onjoin: (code: string) => void;
    onleave: () => void;
  }

  let { study, invalid, busy = false, onjoin, onleave }: Props = $props();

  let code = $state('');
  let localInvalid = $state(false);

  const showInvalid = $derived(invalid || localInvalid);
  const canJoin = $derived(code.trim().length > 0 && !busy);
  const durationMin = $derived(study?.durationSec ? Math.max(1, Math.round(study.durationSec / 60)) : null);
  const instructions = $derived(study ? localized(study.instructions) : '');

  function submit(e: SubmitEvent): void {
    e.preventDefault();
    const trimmed = code.trim();
    if (!trimmed || busy) return;
    if (!isStudyCode(trimmed)) {
      localInvalid = true;
      return;
    }
    localInvalid = false;
    onjoin(trimmed);
  }

  function onInput(): void {
    localInvalid = false;
  }
</script>

<section class="card stack">
  {#if study}
    <div class="stack info">
      <div class="name">{i18n.t('panel.study_loaded', [study.name])}</div>
      <div class="muted small">{i18n.t('panel.study_target', [hostnameOf(study.targetUrl)])}</div>
      {#if durationMin !== null}
        <div class="muted small">{i18n.t('panel.study_duration', [durationMin])}</div>
      {/if}
      {#if instructions}
        <p class="instructions small">{instructions}</p>
      {/if}
      <div>
        <button type="button" class="btn-link small" onclick={onleave}>{i18n.t('panel.study_leave')}</button>
      </div>
    </div>
  {:else}
    <form class="stack" onsubmit={submit}>
      <label class="stack code-label" for="study-code">
        <span class="card-title">{i18n.t('panel.study_code_label')}</span>
        <input
          id="study-code"
          type="text"
          bind:value={code}
          oninput={onInput}
          placeholder={i18n.t('panel.study_code_placeholder')}
          autocomplete="off"
          spellcheck="false"
          aria-invalid={showInvalid}
        />
      </label>
      {#if showInvalid}
        <p class="err small" role="alert">{i18n.t('panel.study_invalid')}</p>
      {/if}
      <button type="submit" class="btn-primary btn-block" disabled={!canJoin}>{i18n.t('panel.join')}</button>
    </form>
  {/if}
</section>

<style>
  .code-label {
    gap: 4px;
  }
  .code-label .card-title {
    margin-bottom: 0;
  }
  .info {
    gap: 3px;
  }
  .name {
    font-weight: 600;
  }
  .instructions {
    margin-top: 4px;
    color: var(--text);
    opacity: 0.85;
    white-space: pre-wrap;
    max-height: 6.5em;
    overflow: auto;
  }
</style>
