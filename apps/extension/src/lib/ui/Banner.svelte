<script lang="ts">
  import { i18n } from '#i18n';

  interface Props {
    kind?: 'info' | 'warn' | 'error' | 'success';
    text: string;
    actionLabel?: string;
    onaction?: () => void;
    ondismiss?: () => void;
  }

  let { kind = 'info', text, actionLabel, onaction, ondismiss }: Props = $props();
</script>

<div class="banner {kind}" role={kind === 'error' ? 'alert' : 'status'}>
  <span class="text">{text}</span>
  {#if actionLabel && onaction}
    <button type="button" class="btn-link action" onclick={onaction}>{actionLabel}</button>
  {/if}
  {#if ondismiss}
    <button type="button" class="dismiss" aria-label={i18n.t('common.close')} onclick={ondismiss}>&times;</button>
  {/if}
</div>

<style>
  .banner {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    padding: 8px 10px;
    border-radius: 6px;
    border: 1px solid var(--border);
    background: var(--panel-2);
    font-size: 12px;
  }
  .text {
    flex: 1 1 auto;
    min-width: 0;
  }
  .action {
    flex: none;
    font-size: 12px;
    color: inherit;
    font-weight: 600;
  }
  .dismiss {
    flex: none;
    background: none;
    border: none;
    padding: 0 2px;
    line-height: 1;
    font-size: 16px;
    color: inherit;
    opacity: 0.7;
  }
  .dismiss:hover {
    opacity: 1;
    background: none;
  }
  .info {
    border-color: rgba(91, 156, 255, 0.4);
    background: rgba(91, 156, 255, 0.1);
  }
  .warn {
    border-color: rgba(240, 180, 41, 0.45);
    background: rgba(240, 180, 41, 0.12);
    color: #f7d27a;
  }
  .error {
    border-color: rgba(255, 92, 92, 0.45);
    background: rgba(255, 92, 92, 0.12);
    color: #ff8a8a;
  }
  .success {
    border-color: rgba(62, 207, 116, 0.45);
    background: rgba(62, 207, 116, 0.12);
    color: #7fe0a4;
  }
</style>
