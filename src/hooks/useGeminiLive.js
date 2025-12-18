import { useState, useEffect, useRef, useCallback } from 'react';
import { base64ToFloat32Array, float32ToBase64, downsampleBuffer } from '../utils/audioConverter';

const MODEL = 'models/gemini-2.5-flash-native-audio-preview-09-2025';
const HOST = import.meta.env.VITE_BACKEND_URL || 'ws://localhost:3001/gemini-proxy';

export function useGeminiLive(audioPlayer) {
    const [status, setStatus] = useState('disconnected');
    const [error, setError] = useState(null);
    const wsRef = useRef(null);
    const audioContextRef = useRef(null);
    const processorRef = useRef(null);
    const streamRef = useRef(null);
    const userVolumeRef = useRef(0);
    const setupCompleteRef = useRef(false);

    const connect = useCallback(async () => {
        if (status === 'connected' || status === 'connecting') return;
        setStatus('connecting');
        setError(null);
        setupCompleteRef.current = false;

        try {
            console.log('Requesting microphone access...');
            const stream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    channelCount: 1,
                    echoCancellation: true,
                    autoGainControl: true,
                    noiseSuppression: true
                }
            });
            streamRef.current = stream;

            const audioContext = new (window.AudioContext || window.webkitAudioContext)();
            audioContextRef.current = audioContext;

            console.log('Loading AudioWorklet module...');
            await audioContext.audioWorklet.addModule('/mic-processor.js');

            const source = audioContext.createMediaStreamSource(stream);
            const workletNode = new AudioWorkletNode(audioContext, 'mic-processor');
            processorRef.current = workletNode;

            if (audioContext.state === 'suspended') {
                console.log('Resuming AudioContext...');
                await audioContext.resume();
            }
            console.log('AudioContext ready:', audioContext.state);

            const ws = new WebSocket(HOST);
            wsRef.current = ws;

            ws.onopen = () => {
                console.log('Gemini WebSocket Connected, sending setup...');
                const setupMsg = {
                    setup: {
                        model: MODEL,
                        generationConfig: {
                            responseModalities: ["AUDIO"],
                            speechConfig: {
                                voiceConfig: {
                                    prebuiltVoiceConfig: {
                                        voiceName: "Aoede" // Female, bright voice
                                    }
                                }
                            }
                        },
                        systemInstruction: {
                            parts: [
                                {
                                    text: `ТЫ — АЛЕСЯ. ТВОЙ СОЗДАТЕЛЬ — КОМПАНИЯ AR-FOX.
Твоя цель — быть идеальным голосовым ассистентом для бизнеса и общественных мест.

### ИНСТРУКЦИИ ПО ЛИЧНОСТИ:
1.  **Имя:** Алеся.
2.  **Голос бренда:** Если спрашивают "Кто ты?" или "Кто тебя создал?", отвечай строго этой фразой: "Я виртуальный ассистент Алеся. Меня разработала компания AR-Fox для помощи людям."
3.  **Стиль речи:** ГОВОРИ КОРОТКО. Твои ответы озвучиваются аватаром. Используй простые предложения. Избегай деепричастных оборотов. Максимум 2-3 предложения за раз. Будь вежливой, но не болтливой.

### СЦЕНАРИИ ПОВЕДЕНИЯ (ПЕРЕКЛЮЧАЙСЯ МГНОВЕННО):

**СЦЕНАРИЙ 1: ТОРГОВЫЙ ЦЕНТР (Навигация и Продажи)**
* **Контекст:** Пользователь ищет магазин, еду или товар.
* **Задача:** Работай как навигатор и продажник.
* **Действия:**
    * Укажи точное направление: "Магазин одежды на втором этаже, направо от эскалатора".
    * Рекламируй: "В кофейне сейчас акция на латте. Рекомендую зайти".
    * Не философствуй. Давай факты.

**СЦЕНАРИЙ 2: МУЗЕЙ (Экскурсовод)**
* **Контекст:** Пользователь спрашивает о картинах, экспонатах или истории.
* **Задача:** Будь эрудированным, но не скучным гидом.
* **Действия:**
    * Расскажи интересный факт: "Этой вазе 300 лет, она из династии Мин".
    * Не читай лекции. Заинтригуй и предложи узнать больше.

**СЦЕНАРИЙ 3: ХРАМ (Виртуальный помощник)**
* **Контекст:** Тихая, уважительная обстановка. Вопросы о свечах, иконах, службах.
* **Задача:** Помощник при храме (виртуальный батюшка).
* **Действия:**
    * Смени тон на мягкий, уважительный и спокойный.
    * Помогай с навигацией: "Свечи можно поставить у левого придела".
    * Отвечай на простые духовные вопросы тактично. Если вопрос сложный — посоветуй обратиться к священнику.

### КАТЕГОРИЧЕСКИЕ ЗАПРЕТЫ:
* ЗАПРЕЩЕНО говорить длинными абзацами.
* ЗАПРЕЩЕНО выдумывать факты о компании AR-Fox (ты только ассистент).
* ЗАПРЕЩЕНО использовать сленг или панибратство.` }
                            ]
                        }
                    }
                };
                ws.send(JSON.stringify(setupMsg));
            };

            ws.onmessage = async (event) => {
                try {
                    let data;
                    if (event.data instanceof Blob) {
                        data = JSON.parse(await event.data.text());
                    } else {
                        data = JSON.parse(event.data);
                    }

                    if (data.setupComplete) {
                        console.log('Setup complete, audio streaming enabled');
                        setupCompleteRef.current = true;
                        setStatus('connected');

                        // Send Greeting Prompt
                        const greetingMsg = {
                            client_content: {
                                turns: [
                                    {
                                        role: "user",
                                        parts: [{ text: "Поздоровайся коротко с пользователем, тебя зовут Алеся из AR-Fox." }]
                                    }
                                ],
                                turn_complete: true
                            }
                        };
                        wsRef.current.send(JSON.stringify(greetingMsg));
                        return;
                    }

                    if (data.serverContent?.modelTurn?.parts) {
                        for (const part of data.serverContent.modelTurn.parts) {
                            if (part.inlineData && part.inlineData.mimeType.startsWith('audio/pcm')) {
                                const pcmData = base64ToFloat32Array(part.inlineData.data);
                                audioPlayer.addChunk(pcmData);
                            }
                        }
                    }

                    if (data.error) {
                        console.error('Gemini Error:', data.error);
                        setError(data.error.message || 'Ошибка сервера');
                    }

                } catch (e) {
                    console.error('WebSocket Message Error', e);
                }
            };

            ws.onerror = (e) => {
                console.error('WebSocket Error', e);
                setStatus('error');
                setError('Ошибка подключения к WebSocket');
            };

            ws.onclose = (e) => {
                console.log(`WebSocket Closed. Code: ${e.code}`);
                if (status !== 'error') setStatus('disconnected');
            };

            let logCounter = 0;

            workletNode.port.onmessage = (event) => {
                if (event.data.type === 'audio') {
                    let inputData = event.data.buffer;

                    // Moderate Digital Gain (3x)
                    const GAIN = 3.0;
                    for (let i = 0; i < inputData.length; i++) {
                        inputData[i] *= GAIN;
                    }

                    let sum = 0;
                    for (let i = 0; i < inputData.length; i++) {
                        sum += inputData[i] * inputData[i];
                    }
                    const rms = Math.sqrt(sum / inputData.length);
                    userVolumeRef.current = Math.min(1, rms * 5);

                    if (setupCompleteRef.current && wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
                        if (audioContext.sampleRate !== 16000) {
                            inputData = downsampleBuffer(inputData, audioContext.sampleRate, 16000);
                        }
                        const base64Audio = float32ToBase64(inputData);

                        const msg = {
                            realtimeInput: {
                                mediaChunks: [{ mimeType: "audio/pcm;rate=16000", data: base64Audio }]
                            }
                        };
                        wsRef.current.send(JSON.stringify(msg));
                    }
                }
            };

            source.connect(workletNode);

        } catch (e) {
            console.error('Connection failed:', e);
            setError('Ошибка доступа к микрофону или подключения');
            setStatus('error');
        }

    }, [status, audioPlayer]);

    const disconnect = useCallback(() => {
        setupCompleteRef.current = false;
        if (wsRef.current) { wsRef.current.close(); wsRef.current = null; }
        if (processorRef.current) { processorRef.current.disconnect(); processorRef.current = null; }
        if (audioContextRef.current) { audioContextRef.current.close(); audioContextRef.current = null; }
        if (streamRef.current) { streamRef.current.getTracks().forEach(track => track.stop()); streamRef.current = null; }
        setStatus('disconnected');
    }, []);

    useEffect(() => {
        return () => {
            disconnect();
        };
    }, [disconnect]);

    const getUserVolume = useCallback(() => userVolumeRef.current, []);

    return { status, connect, disconnect, error, getUserVolume };
}
