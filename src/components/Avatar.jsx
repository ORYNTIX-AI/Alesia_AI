import React, { useMemo } from 'react';
import { useFrame } from '@react-three/fiber';
import { useGLTF } from '@react-three/drei';
import { clone } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { useLipSync } from '../hooks/useLipSync';

// ARKit and Oculus Visemes are required for specific lip-sync morphs
export const DEFAULT_AVATAR_MODEL_URL = 'https://models.readyplayer.me/6940682e5917bffe25eb75ed.glb?morphTargets=ARKit,Oculus+Visemes';

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

export function Avatar({ audioPlayer, modelUrl = DEFAULT_AVATAR_MODEL_URL, instanceId }) {
    const { scene } = useGLTF(modelUrl);
    const analyser = audioPlayer?.analyser;
    const avatarRef = React.useRef();
    const avatarScene = useMemo(() => cloneAvatarScene(scene, instanceId), [scene, instanceId]);

    // Custom Hook for Spectral Lip-Sync
    useLipSync({ scene: avatarScene, analyser });

    // Idle Animation: Subtle breathing/sway
    useFrame((state) => {
        if (avatarRef.current) {
            const t = state.clock.getElapsedTime();
            // Gentle Head/Body Sway
            avatarRef.current.rotation.y = Math.sin(t * 0.5) * 0.03; // Left-Right slow
            avatarRef.current.rotation.x = Math.sin(t * 0.3) * 0.02; // Up-Down breath
        }
    });

    return (
        <primitive
            ref={avatarRef}
            object={avatarScene}
            position={[0, 0, 0]}
            scale={1.3}
        />
    );
}

useGLTF.preload(DEFAULT_AVATAR_MODEL_URL);
