import { useFrame } from '@react-three/fiber';
import { useEffect, useRef } from 'react';
import * as THREE from 'three';

// КОНФИГУРАЦИЯ ФИЗИКИ ГУБ
const SMOOTH_TIME = 0.15; // Время сглаживания (инерция мышц). Чем больше, тем плавнее.
const THRESHOLD = 0.1;   // Отсекаем фоновый шум (чтобы рот не дрожал в тишине)
const BOOST = 1.0;        // Усиление амплитуды (Normalized)

export function useLipSync({ scene, analyser }) {
    const headRef = useRef(null);

    // Храним текущие скорости для каждого морфа (нужно для физики Damping)
    const velocities = useRef({
        viseme_aa: 0,
        viseme_E: 0,
        viseme_U: 0,
        viseme_O: 0,
        viseme_SS: 0
    });

    useEffect(() => {
        if (!scene) return;
        scene.traverse((node) => {
            // Ищем голову (Oculus standard)
            if (node.isMesh && node.morphTargetDictionary && node.morphTargetDictionary['viseme_aa'] !== undefined) {
                headRef.current = node;
            }
        });
    }, [scene]);

    // Buffer Ref to avoid GC every frame
    const dataRef = useRef(new Uint8Array(1024));

    useEffect(() => {
        if (analyser) {
            dataRef.current = new Uint8Array(analyser.frequencyBinCount);
        }
    }, [analyser]);

    useFrame((state, delta) => {
        if (!headRef.current || !analyser) return;

        analyser.getByteFrequencyData(dataRef.current);
        const frequencyData = dataRef.current;

        // Функция: Получаем энергию диапазона с отсечением шума
        const getTargetValue = (min, max) => {
            let energy = 0;
            for (let i = min; i < max; i++) energy += frequencyData[i];
            let norm = energy / (max - min) / 255;

            if (norm < THRESHOLD) return 0; // Hard Noise Gate

            // GAMMA CURVE: The Secret Sauce
            // Raises value to power of 2.5.
            // Low values (0.2) become tiny (0.01) -> Mouth closes
            // High values (0.9) stay high (0.76) -> Mouth opens
            norm = Math.pow(norm, 2.5);

            // SAFETY CAP: Strict Anatomical Limit (0.6)
            return Math.min(norm * BOOST, 0.6);
        };

        // Маппинг частот (стандарт Oculus)
        // AudioConfig: 2048 FFT -> Bin Size ~21.5 Hz

        // 1. AA (Jaw Open) -> Active in Vocal Range (300-800Hz)
        // Bins ~14 to ~37
        const rawAA = getTargetValue(14, 40);

        // 2. EE (Smile/Teeth) -> Active in High Formants (1500-3000Hz)
        // Bins ~70 to ~140
        const rawEE = getTargetValue(70, 140);

        // 3. UU (Pout) -> Active in Bass/Fundamental (100-300Hz)
        // Bins ~4 to ~14
        const rawUU = getTargetValue(4, 14);

        // 4. Sibiliants (S/Sh) -> Very High (4000Hz+)
        const rawSS = getTargetValue(180, 250);

        // --- LOGIC: DOMINANCE SOLVER ---
        // Problem: "AA" triggers on everything.
        // Solution: If distinct vowels (EE, UU) are detected, suppress AA.

        let targetAA = rawAA;
        let targetEE = rawEE * 1.3; // Boost highs slightly
        let targetUU = rawUU * 1.2;

        // Rule 1: "I" (Ee) dominance.
        // If High Mids are strong, we are saying "Ee". Close the jaw.
        if (targetEE > 0.2) {
            targetAA = targetAA * 0.3; // Suppress A
            // If really strong E, kill A entirely to show teeth
            if (targetEE > 0.5) targetAA = 0;
        }

        // Rule 2: "U" (Oo) dominance.
        // If Bass is strong AND Highs are weak, we are saying "Oo".
        if (targetUU > 0.2 && targetEE < 0.3) {
            targetAA = targetAA * 0.3; // Suppress A
            targetEE = 0;              // Suppress Smile
        }

        const targets = {
            viseme_aa: targetAA,
            viseme_E: targetEE,
            viseme_U: targetUU,
            viseme_O: targetUU * 0.7,
            viseme_SS: rawSS,
        };

        // ГЛАВНОЕ ИЗМЕНЕНИЕ: Физика (Smooth Damping) вместо Lerp
        Object.entries(targets).forEach(([viseme, targetValue]) => {
            const index = headRef.current.morphTargetDictionary[viseme];
            if (index !== undefined) {
                const current = headRef.current.morphTargetInfluences[index];

                // Математика Damping (эмуляция пружины)
                // smoothDamp(текущее, цель, скорость, время_сглаживания, макс_скорость, дельта_время)
                // Пишем упрощенный damp вручную, так как в THREE.MathUtils его нет в чистом виде

                // Вариант с MathUtils.damp (похож на lerp, но с экспоненциальным затуханием)
                // Параметр lambda: чем выше, тем резче.

                // Используем проверенный алгоритм "Attack/Decay"
                // Открываемся быстро (Attack), закрываемся медленно (Decay)
                // USER REQUEST: Snap shut instantly.
                const speed = targetValue > current ? 90 : 100; // 100 = Instant Close



                headRef.current.morphTargetInfluences[index] = THREE.MathUtils.damp(
                    current,
                    targetValue,
                    speed,
                    delta
                );
            }
        });

        // --- RESTORED IDLE ANIMATION (BLINKING) ---
        const blinkIdx = headRef.current.morphTargetDictionary['eyesClosed'];
        if (blinkIdx !== undefined) {
            if (Math.random() < 0.005) {
                headRef.current.morphTargetInfluences[blinkIdx] = 1; // Instant close
            } else {
                const currentBlink = headRef.current.morphTargetInfluences[blinkIdx];
                headRef.current.morphTargetInfluences[blinkIdx] = THREE.MathUtils.damp(currentBlink, 0, 10, delta);
            }
        }
    });
}
