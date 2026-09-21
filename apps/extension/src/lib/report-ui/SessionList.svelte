<script lang="ts">
  import { untrack } from 'svelte';
  import type { Session } from '@red-tracking/protocol';
  import { i18n } from '#i18n';
  import { deleteSession, listSessions } from '../db';
  import { importZip } from '../report/export';
  import { fmtDate, fmtDuration, go } from './nav';

  let sessions = $state<Session[]>([]);
  let busy = $state(false);
  let error = $state<string | null>(null);

  async function refresh() {
    sessions = await listSessions();
  }
  $effect(() => {
    untrack(() => void refresh());
  });

  async function onImport(e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    busy = true;
    error = null;
    try {
      const id = await importZip(file);
      go({ name: 'session', id });
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      busy = false;
      input.value = '';
    }
  }

  async function remove(s: Session) {
    if (!confirm(i18n.t('report.confirm_delete'))) return;
    await deleteSession(s.id);
    await refresh();
  }

  const studyName = (s: Session) => s.study?.name ?? s.studyId ?? '—';
</script>

<div class="grid">
  <div class="row" style="justify-content: space-between">
    <h2 style="margin:0">{i18n.t('report.session_list')}</h2>
    <div class="row">
      <label class="btn" style="margin:0; cursor:pointer; color: var(--text)">
        {i18n.t('report.import_zip')}
        <input type="file" accept=".zip,application/zip" style="display:none" onchange={onImport} disabled={busy} />
      </label>
      <button class="primary" onclick={() => go({ name: 'study' })}>{i18n.t('report.study_new')}</button>
    </div>
  </div>
  {#if error}<div class="card" style="color:#ff8c85">{error}</div>{/if}
  {#if sessions.length === 0}
    <div class="card muted">{i18n.t('report.no_sessions')}</div>
  {:else}
    <div class="card" style="padding:0; overflow:auto">
      <table>
        <thead>
          <tr>
            <th>Fecha</th>
            <th>Estudio</th>
            <th class="num">{i18n.t('report.summary_duration')}</th>
            <th>{i18n.t('report.summary_accuracy')}</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {#each sessions as s (s.id)}
            <tr>
              <td><a href={'?session=' + s.id} onclick={(e) => { e.preventDefault(); go({ name: 'session', id: s.id }); }}>{fmtDate(s.createdAt)}</a></td>
              <td>{studyName(s)} <span class="tag">{s.state}</span></td>
              <td class="num">{fmtDuration(s.recordedMs)}</td>
              <td>{s.validation ? `${s.validation.meanErrPx.toFixed(0)} px` : '—'}</td>
              <td><button class="danger" onclick={() => remove(s)}>{i18n.t('report.delete_session')}</button></td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
</div>
