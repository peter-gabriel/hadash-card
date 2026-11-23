import { afterEach, describe, expect, it } from 'vitest';
import { setLanguage, strings, t } from '../src/i18n';
import { ago } from '../src/actions';
import { demoFloors } from '../src/house';
import { stateText } from '../src/states';

describe('i18n', () => {
  afterEach(() => setLanguage({ language: 'en' }));

  it('picks the language by prefix and falls back to English', () => {
    expect(strings('pt-BR').rooms).toBe('Cômodos');
    expect(strings('es-MX').rooms).toBe('Habitaciones');
    expect(strings('de').rooms).toBe('Rooms');
    expect(strings(undefined).rooms).toBe('Rooms');
  });

  it('has every key in every language', () => {
    const keys = (o: object) => Object.keys(o).sort();
    const en = strings('en');
    for (const l of ['pt', 'es']) {
      const s = strings(l);
      expect(keys(s)).toEqual(keys(en));
      expect(keys(s.states)).toEqual(keys(en.states));
      expect(keys(s.weather)).toEqual(keys(en.weather));
    }
  });

  it('follows the HA profile language, locale first', () => {
    setLanguage({ language: 'en', locale: { language: 'es' } });
    expect(t().actions).toBe('Acciones');
    expect(setLanguage({ language: 'es' })).toBe(false);
    expect(setLanguage({ language: 'pt-BR' })).toBe(true);
    expect(t().actions).toBe('Ações');
  });

  it('translates states, last run and the example house', () => {
    setLanguage({ language: 'es' });
    expect(stateText({ entity_id: 'switch.x', state: 'off', attributes: {}, last_changed: '', last_updated: '' })).toBe('apagado');
    expect(ago(new Date(Date.now() - 3 * 60_000).toISOString())).toBe('hace 3 min');
    expect(demoFloors()[0].name).toBe('Planta baja');
    setLanguage({ language: 'pt-BR' });
    expect(demoFloors()[0].name).toBe('Térreo');
  });
});
