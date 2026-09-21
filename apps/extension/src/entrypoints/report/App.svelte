<script lang="ts">
  import { i18n } from '#i18n';
  import SessionList from '../../lib/report-ui/SessionList.svelte';
  import SessionReport from '../../lib/report-ui/SessionReport.svelte';
  import StudyForm from '../../lib/report-ui/StudyForm.svelte';
  import { currentRoute, go, type Route } from '../../lib/report-ui/nav';

  let route = $state<Route>(currentRoute());
  $effect(() => {
    const onPop = () => (route = currentRoute());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  });
</script>

<div style="max-width: 1440px; margin: 0 auto; padding: 20px; display: grid; gap: 18px">
  <header class="row" style="justify-content: space-between">
    <div class="row">
      <img src="/icons/icon-32.png" alt="" width="28" height="28" />
      <h1>red-tracking · {i18n.t('report.title')}</h1>
    </div>
    <nav class="row">
      <button class:active={route.name === 'home'} onclick={() => go({ name: 'home' })}>{i18n.t('report.session_list')}</button>
      <button class:active={route.name === 'study'} onclick={() => go({ name: 'study' })}>{i18n.t('report.study_new')}</button>
    </nav>
  </header>
  {#if route.name === 'session'}
    <SessionReport sessionId={route.id} />
  {:else if route.name === 'study'}
    <StudyForm />
  {:else}
    <SessionList />
  {/if}
</div>
