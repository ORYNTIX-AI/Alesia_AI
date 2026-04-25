import test from 'node:test'
import assert from 'node:assert/strict'
import { sanitizeAppConfig } from '../../server/configStore.js'

test('sanitizeAppConfig migrates legacy config into schema v2 runtime shape', () => {
  const migrated = sanitizeAppConfig({
    themeMode: 'dark',
    activeCharacterId: 'alesya-puck',
    characters: [
      {
        id: 'alesya-puck',
        displayName: 'Николай',
        runtimeProvider: 'yandex-full',
        voiceModelId: 'yandexgpt-lite/latest',
        voiceName: 'Puck',
        backgroundPreset: 'white',
        systemPrompt: '',
        greetingText: '',
        avatarModelUrl: '/avatars/nikolay.glb',
        avatarInstanceId: 'avatar-batyushka',
        browserPanelMode: 'client-inline',
        pageContextMode: 'url-fetch',
        knowledgePriorityTags: ['church'],
      },
    ],
    webProviders: {
      weather: {
        label: 'Погода',
        urlTemplate: 'https://yandex.by/pogoda/ru/minsk',
      },
      news: {
        label: 'Новости',
        urlTemplate: 'https://news.mail.ru/',
      },
      currency: {
        label: 'Курсы',
        urlTemplate: 'https://finance.mail.ru/currency/',
      },
      maps: {
        label: 'Карты',
        urlTemplate: 'https://yandex.by/maps/?text={query}',
      },
      wiki: {
        label: 'Wiki',
        urlTemplate: 'https://ru.wikipedia.org/wiki/{query}',
      },
      search: {
        label: 'Поиск',
        urlTemplate: 'https://www.onliner.by/',
      },
    },
    knowledgeSources: [],
  })

  assert.equal(migrated.schemaVersion, 2)
  assert.equal(migrated.themeMode, 'dark')
  assert.equal(migrated.activeCharacterId, 'alesya-puck')
  assert.equal(Array.isArray(migrated.characters), true)
  assert.equal(migrated.characters.length >= 1, true)

  const batyushka = migrated.characters.find((character) => character.id === 'alesya-puck')
  assert.ok(batyushka)
  assert.equal(batyushka.runtimeProvider, 'yandex-full-legacy')
  assert.equal(batyushka.browserPanelMode, 'client-inline')
  assert.equal(batyushka.pageContextMode, 'url-fetch')
  assert.equal(batyushka.systemPromptRef, 'batyushka')
  assert.equal(batyushka.greetingRef, 'batyushka')
  assert.equal(Boolean(batyushka.systemPrompt), true)
  assert.equal(Boolean(batyushka.greetingText), true)
  assert.equal(batyushka.avatarModelUrl, 'avatars/nikolay.glb')
  assert.equal('safetySwitches' in migrated, false)
})
