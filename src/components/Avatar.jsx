import React, { useMemo } from 'react';
import { useFrame } from '@react-three/fiber';
import { useGLTF } from '@react-three/drei';
import { clone } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { useLipSync } from '../hooks/useLipSync';

// ARKit and Oculus Visemes are required for specific lip-sync morphs
export const DEFAULT_AVATAR_MODEL_URL = 'avatars/alesya.glb';
const DEFAULT_IDLE_MOTION_PROFILE = {
    yawAmplitude: 0.03,
    yawSpeed: 0.5,
    pitchAmplitude: 0.02,
    pitchSpeed: 0.3,
    bobAmplitude: 0.012,
    bobSpeed: 0.42,
};

function cloneAvatarScene(sourceScene, instanceId) {
    const nextScene = clone(sourceScene);
    nextScene.userData.avatarInstanceId = instanceId;
    nextScene.name = instanceId || nextScene.name;

    nextScene.traverse((node) => {
        if (!node.isMesh) return;

        if (Array.isArray(node.material)) {
            node.material = node.material.map((material) => (material?.clone ? material.clone() : material));
            return;
        }

        if (node.material?.clone) {
            node.material = node.material.clone();
        }
    });

    return nextScene;
}

export function Avatar({
    audioPlayer,
    modelUrl = DEFAULT_AVATAR_MODEL_URL,
    instanceId,
    scale = 1.3,
    idleMotion = true,
    idleMotionProfile = DEFAULT_IDLE_MOTION_PROFILE,
}) {
    const { scene } = useGLTF(modelUrl);
    const analyser = audioPlayer?.analyser;
    const avatarRef = React.useRef();
    const baseYRef = React.useRef(0);
    const avatarScene = useMemo(() => cloneAvatarScene(scene, instanceId), [scene, instanceId]);

    // Custom Hook for Spectral Lip-Sync
    useLipSync({ scene: avatarScene, analyser });

    // Idle Animation: Subtle breathing/sway
    useFrame((state) => {
        if (avatarRef.current && idleMotion) {
            const t = state.clock.getElapsedTime();
            const yawAmplitude = Number.isFinite(idleMotionProfile?.yawAmplitude) ? idleMotionProfile.yawAmplitude : DEFAULT_IDLE_MOTION_PROFILE.yawAmplitude;
            const yawSpeed = Number.isFinite(idleMotionProfile?.yawSpeed) ? idleMotionProfile.yawSpeed : DEFAULT_IDLE_MOTION_PROFILE.yawSpeed;
            const pitchAmplitude = Number.isFinite(idleMotionProfile?.pitchAmplitude) ? idleMotionProfile.pitchAmplitude : DEFAULT_IDLE_MOTION_PROFILE.pitchAmplitude;
            const pitchSpeed = Number.isFinite(idleMotionProfile?.pitchSpeed) ? idleMotionProfile.pitchSpeed : DEFAULT_IDLE_MOTION_PROFILE.pitchSpeed;
            const bobAmplitude = Number.isFinite(idleMotionProfile?.bobAmplitude) ? idleMotionProfile.bobAmplitude : DEFAULT_IDLE_MOTION_PROFILE.bobAmplitude;
            const bobSpeed = Number.isFinite(idleMotionProfile?.bobSpeed) ? idleMotionProfile.bobSpeed : DEFAULT_IDLE_MOTION_PROFILE.bobSpeed;
            // Gentle Head/Body Sway
            avatarRef.current.rotation.y = Math.sin(t * yawSpeed) * yawAmplitude;
            avatarRef.current.rotation.x = Math.sin(t * pitchSpeed) * pitchAmplitude;
            avatarRef.current.position.y = baseYRef.current + (Math.sin(t * bobSpeed) * bobAmplitude);
        } else if (avatarRef.current) {
            avatarRef.current.rotation.y = 0;
            avatarRef.current.rotation.x = 0;
            avatarRef.current.position.y = baseYRef.current;
        }
    });

    return (
        <primitive
            ref={avatarRef}
            object={avatarScene}
            position={[0, 0, 0]}
            scale={scale}
        />
    );
}

useGLTF.preload(DEFAULT_AVATAR_MODEL_URL);
