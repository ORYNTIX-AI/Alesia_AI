import React from 'react'
import { buildSignature } from '../session/sessionModels.js'

export function useDemoConfigActions({
  config,
  persistConfig,
  requestReconnectForSignature,
  selectedCharacter,
  setSettingsDraft,
  setSettingsOpen,
  testerSettings,
  themeMode,
}) {
  const [saveError, setSaveError] = React.useState(null)

  const commitConfig = React.useCallback(async (nextConfig) => {
    try {
      const saved = await persistConfig(nextConfig)
      setSaveError(null)
      return saved
    } catch (persistError) {
      setSaveError(persistError.message || 'Failed to save changes')
      throw persistError
    }
  }, [persistConfig])

  const handleCharacterStep = React.useCallback(async (direction) => {
    if (!config?.characters?.length) return

    const currentIndex = config.characters.findIndex((character) => character.id === config.activeCharacterId)
    const nextIndex = (currentIndex + direction + config.characters.length) % config.characters.length
    await commitConfig({
      ...config,
      activeCharacterId: config.characters[nextIndex].id,
    })
  }, [commitConfig, config])

  const handleOpenSettings = React.useCallback(() => {
    setSettingsDraft(selectedCharacter)
    setSettingsOpen(true)
  }, [selectedCharacter, setSettingsDraft, setSettingsOpen])

  const handleSaveSettings = React.useCallback(async (settingsDraft) => {
    if (!config || !settingsDraft || !selectedCharacter) return

    const nextConfig = {
      ...config,
      characters: config.characters.map((character) => (
        character.id === selectedCharacter.id
          ? { ...character, ...settingsDraft }
          : character
      )),
    }

    const savedConfig = await commitConfig(nextConfig)
    const savedCharacter = savedConfig?.characters?.find((character) => character.id === selectedCharacter.id)
    const nextSignature = buildSignature(savedCharacter, {
      pauseMs: testerSettings.pauseMs,
      firstReplySentences: testerSettings.firstReplySentences,
      memoryTurnCount: testerSettings.memoryTurnCount,
    })

    requestReconnectForSignature(nextSignature)
    setSettingsOpen(false)
  }, [
    commitConfig,
    config,
    requestReconnectForSignature,
    selectedCharacter,
    setSettingsOpen,
    testerSettings.firstReplySentences,
    testerSettings.memoryTurnCount,
    testerSettings.pauseMs,
  ])

  const handleThemeToggle = React.useCallback(async () => {
    if (!config) return
    await commitConfig({
      ...config,
      themeMode: themeMode === 'dark' ? 'light' : 'dark',
    })
  }, [commitConfig, config, themeMode])

  return {
    handleCharacterStep,
    handleOpenSettings,
    handleSaveSettings,
    handleThemeToggle,
    saveError,
  }
}
