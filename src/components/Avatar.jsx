import React from 'react';
import { useFrame } from '@react-three/fiber';
import { useGLTF } from '@react-three/drei';
import { useLipSync } from '../hooks/useLipSync';

// ARKit and Oculus Visemes are required for specific lip-sync morphs
const AVATAR_URL = 'https://models.readyplayer.me/6940682e5917bffe25eb75ed.glb?morphTargets=ARKit,Oculus+Visemes';

export function Avatar({ audioPlayer }) {
    const { scene } = useGLTF(AVATAR_URL);
    const analyser = audioPlayer?.analyser;
    const avatarRef = React.useRef();

    // Custom Hook for Spectral Lip-Sync
    useLipSync({ scene, analyser });

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
            object={scene}
            position={[0, 0, 0]}
            scale={1.3}
        />
    );
}

useGLTF.preload(AVATAR_URL);
