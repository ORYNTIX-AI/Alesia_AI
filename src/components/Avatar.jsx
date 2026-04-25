import React, { useLayoutEffect, useMemo } from 'react';
import { useFrame, useLoader } from '@react-three/fiber';
import { Box3, Vector3 } from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone as cloneSkeleton } from 'three/examples/jsm/utils/SkeletonUtils.js';
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

function resolveModelUrl(modelUrl) {
    const normalizedUrl = String(modelUrl || '').trim();
    if (!normalizedUrl) {
        throw new Error('Avatar model URL is empty');
    }

    if (typeof window === 'undefined') {
        return normalizedUrl;
    }

    return new URL(normalizedUrl.replace(/^\/+/, ''), `${window.location.origin}/`).toString();
}

function cloneAvatarScene(sourceScene, instanceId) {
    const nextScene = cloneSkeleton(sourceScene);
    nextScene.userData.avatarInstanceId = instanceId;
    nextScene.name = instanceId || nextScene.name;

    nextScene.traverse((node) => {
        if (!node.isMesh) return;
        node.frustumCulled = false;

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
    focusYRatio = null,
    idleMotion = true,
    idleMotionProfile = DEFAULT_IDLE_MOTION_PROFILE,
}) {
    const analyser = audioPlayer?.analyser;
    const avatarRef = React.useRef();
    const basePositionRef = React.useRef({ x: 0, y: 0, z: 0 });
    const resolvedModelUrl = useMemo(() => resolveModelUrl(modelUrl), [modelUrl]);
    const gltf = useLoader(GLTFLoader, resolvedModelUrl);
    const sourceScene = gltf?.scene || null;
    const avatarScene = useMemo(() => (
        sourceScene ? cloneAvatarScene(sourceScene, instanceId) : null
    ), [sourceScene, instanceId]);

    // Custom Hook for Spectral Lip-Sync
    useLipSync({ scene: avatarScene, analyser, getVolume: audioPlayer?.getVolume?.bind(audioPlayer) });

    useLayoutEffect(() => {
        if (!avatarRef.current || !avatarScene) {
            return;
        }

        const bounds = new Box3().setFromObject(avatarScene);
        if (bounds.isEmpty()) {
            basePositionRef.current = { x: 0, y: 0, z: 0 };
            return;
        }

        const size = new Vector3();
        const center = new Vector3();
        bounds.getSize(size);
        bounds.getCenter(center);
        const minY = Number.isFinite(bounds.min.y) ? bounds.min.y : 0;
        const maxY = Number.isFinite(bounds.max.y) ? bounds.max.y : 0;
        const height = Number.isFinite(size.y) ? size.y : 0;
        const normalizedFocus = Number.isFinite(focusYRatio)
            ? Math.min(0.96, Math.max(0.04, focusYRatio))
            : 0.5;
        const focusY = height > 0 ? minY + (height * normalizedFocus) : (minY + maxY) / 2;
        basePositionRef.current = {
            x: Number.isFinite(center.x) ? -center.x : 0,
            y: -focusY,
            z: Number.isFinite(center.z) ? -center.z : 0,
        };
        avatarRef.current.position.set(
            basePositionRef.current.x,
            basePositionRef.current.y,
            basePositionRef.current.z,
        );
    }, [avatarScene, focusYRatio]);

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
            avatarRef.current.position.x = basePositionRef.current.x;
            avatarRef.current.position.y = basePositionRef.current.y + (Math.sin(t * bobSpeed) * bobAmplitude);
            avatarRef.current.position.z = basePositionRef.current.z;
        } else if (avatarRef.current) {
            avatarRef.current.rotation.y = 0;
            avatarRef.current.rotation.x = 0;
            avatarRef.current.position.set(
                basePositionRef.current.x,
                basePositionRef.current.y,
                basePositionRef.current.z,
            );
        }
    });

    if (!avatarScene) {
        return null;
    }

    return (
        <primitive
            ref={avatarRef}
            object={avatarScene}
            position={[0, 0, 0]}
            scale={scale}
        />
    );
}
