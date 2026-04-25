import { DEFAULT_AVATAR_MODEL_URL } from '../../components/Avatar.jsx'

const BATYUSHKA_CHARACTER_IDS = new Set(['alesya-puck', 'batyushka-2', 'batyushka-3'])

export const BACKGROUND_PRESETS = {
  aurora: {
    stage: 'radial-gradient(circle at 20% 18%, rgba(247, 255, 254, 0.16) 0%, transparent 22%), radial-gradient(circle at 78% 22%, rgba(190, 255, 250, 0.14) 0%, transparent 28%), linear-gradient(160deg, #88d3df 0%, #5ba7ba 46%, #1f4f66 100%)',
    canvasBackground: '#6aa7b8',
    shadow: 'rgba(34, 112, 127, 0.28)',
    border: 'rgba(209, 251, 248, 0.42)',
  },
  sunset: {
    stage: 'radial-gradient(circle at 18% 15%, rgba(255, 244, 226, 0.16) 0%, transparent 22%), radial-gradient(circle at 76% 24%, rgba(255, 186, 164, 0.18) 0%, transparent 28%), linear-gradient(160deg, #ffbb77 0%, #ff7d78 48%, #7f467d 100%)',
    canvasBackground: '#d9877d',
    shadow: 'rgba(147, 68, 78, 0.28)',
    border: 'rgba(255, 227, 198, 0.42)',
  },
  midnight: {
    stage: 'radial-gradient(circle at 22% 18%, rgba(128, 222, 255, 0.12) 0%, transparent 18%), radial-gradient(circle at 80% 24%, rgba(135, 129, 255, 0.12) 0%, transparent 22%), linear-gradient(165deg, #15224b 0%, #091327 58%, #020814 100%)',
    canvasBackground: '#16254e',
    shadow: 'rgba(6, 15, 36, 0.42)',
    border: 'rgba(96, 150, 255, 0.24)',
  },
  forest: {
    stage: 'radial-gradient(circle at 20% 18%, rgba(233, 255, 241, 0.12) 0%, transparent 18%), radial-gradient(circle at 76% 24%, rgba(172, 233, 194, 0.12) 0%, transparent 25%), linear-gradient(160deg, #8ac77b 0%, #378a69 44%, #173728 100%)',
    canvasBackground: '#3a7259',
    shadow: 'rgba(29, 74, 52, 0.3)',
    border: 'rgba(219, 255, 228, 0.38)',
  },
  church: {
    stage: 'linear-gradient(180deg, rgba(248, 249, 250, 0.68) 0%, rgba(235, 236, 238, 0.72) 100%), url("/backgrounds/church-real.jpg") center center / cover no-repeat',
    canvasBackground: null,
    shadow: 'rgba(78, 84, 95, 0.18)',
    border: 'rgba(216, 220, 226, 0.92)',
  },
  hotel: {
    stage: 'linear-gradient(180deg, rgba(246, 247, 249, 0.62) 0%, rgba(230, 233, 238, 0.66) 100%), url("/backgrounds/hotel.jpg") center center / cover no-repeat',
    canvasBackground: null,
    shadow: 'rgba(66, 74, 87, 0.2)',
    border: 'rgba(219, 225, 233, 0.9)',
  },
  beach: {
    stage: 'linear-gradient(180deg, rgba(240, 248, 251, 0.45) 0%, rgba(217, 239, 247, 0.55) 100%), url("/backgrounds/beach.jpg") center center / cover no-repeat',
    canvasBackground: null,
    shadow: 'rgba(52, 97, 122, 0.22)',
    border: 'rgba(205, 235, 247, 0.88)',
  },
  white: {
    stage: 'linear-gradient(180deg, #ffffff 0%, #f5f5f5 100%)',
    canvasBackground: '#ffffff',
    shadow: 'rgba(0, 0, 0, 0.1)',
    border: 'rgba(227, 227, 227, 0.9)',
  },
}

export function getAvatarStageModel(uiCharacter) {
  const activeBackground = BACKGROUND_PRESETS[uiCharacter?.backgroundPreset] || BACKGROUND_PRESETS.aurora
  const avatarModelUrl = uiCharacter?.avatarModelUrl || DEFAULT_AVATAR_MODEL_URL
  const avatarInstanceId = uiCharacter?.avatarInstanceId || `avatar-${uiCharacter?.id || 'default'}`
  const avatarFrame = BATYUSHKA_CHARACTER_IDS.has(uiCharacter?.id || '')
    ? {
      y: 0.48,
      scale: 1.14,
      focusYRatio: 1.31,
      camera: { position: [0, 0.48, 1.38], fov: 26 },
      lights: { ambient: 1.26, directional: 1.08 },
      idleMotion: true,
      idleMotionProfile: {
        yawAmplitude: 0.024,
        yawSpeed: 0.34,
        pitchAmplitude: 0.014,
        pitchSpeed: 0.22,
        bobAmplitude: 0.009,
        bobSpeed: 0.34,
      },
    }
    : {
      y: -0.75,
      scale: 1.3,
      camera: { position: [0, 0, 0.64], fov: 45 },
      lights: { ambient: 1.02, directional: 0.78 },
      idleMotion: true,
      idleMotionProfile: {
        yawAmplitude: 0.03,
        yawSpeed: 0.5,
        pitchAmplitude: 0.02,
        pitchSpeed: 0.3,
      },
    }

  const avatarRenderKey = [
    avatarInstanceId,
    avatarModelUrl,
    uiCharacter?.backgroundPreset || 'aurora',
    avatarFrame.y,
    avatarFrame.scale,
    avatarFrame.focusYRatio,
    avatarFrame.camera.position[2],
    avatarFrame.camera.fov,
    avatarFrame.lights.ambient,
    avatarFrame.lights.directional,
    avatarFrame.idleMotion,
    avatarFrame.idleMotionProfile?.yawAmplitude,
    avatarFrame.idleMotionProfile?.yawSpeed,
    avatarFrame.idleMotionProfile?.pitchAmplitude,
    avatarFrame.idleMotionProfile?.pitchSpeed,
    avatarFrame.idleMotionProfile?.bobAmplitude,
    avatarFrame.idleMotionProfile?.bobSpeed,
  ].join('|')

  return {
    activeBackground,
    avatarModelUrl,
    avatarInstanceId,
    avatarFrame,
    avatarRenderKey,
  }
}
