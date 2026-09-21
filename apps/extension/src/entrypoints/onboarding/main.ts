import { mount } from 'svelte';
import { i18n } from '#i18n';
import '../../lib/ui/theme.css';
import App from './App.svelte';

document.title = i18n.t('onboarding.title');
document.documentElement.lang = navigator.language.toLowerCase().startsWith('en') ? 'en' : 'es';

mount(App, { target: document.getElementById('app')! });
