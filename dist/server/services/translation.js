import axios from 'axios';
import OpenAI from 'openai';
const DEEPL_MAP = {
    pt: 'PT-BR',
    en: 'EN-US',
    es: 'ES',
    fr: 'FR',
    de: 'DE',
    it: 'IT',
    ja: 'JA',
    zh: 'ZH',
    ru: 'RU',
    ar: 'AR',
};
const DEEPL_REVERSE = Object.fromEntries(Object.entries(DEEPL_MAP).map(([k, v]) => [v, k]));
function getDeeplKey() {
    return process.env.DEEPL_API_KEY;
}
function getOpenAIClient() {
    const key = process.env.OPENAI_API_KEY;
    if (!key)
        return null;
    return new OpenAI({ apiKey: key });
}
async function translateWithDeepl(text, from, to) {
    const key = getDeeplKey();
    if (!key)
        return null;
    const baseUrl = key.endsWith(':fx')
        ? 'https://api-free.deepl.com/v2'
        : 'https://api.deepl.com/v2';
    try {
        const res = await axios.post(`${baseUrl}/translate`, new URLSearchParams({
            text,
            source_lang: DEEPL_MAP[from].split('-')[0],
            target_lang: DEEPL_MAP[to],
        }), { headers: { Authorization: `DeepL-Auth-Key ${key}` }, timeout: 8000 });
        return res.data.translations?.[0]?.text ?? null;
    }
    catch {
        return null;
    }
}
async function detectWithDeepl(text) {
    const key = getDeeplKey();
    if (!key)
        return null;
    const baseUrl = key.endsWith(':fx')
        ? 'https://api-free.deepl.com/v2'
        : 'https://api.deepl.com/v2';
    try {
        const res = await axios.post(`${baseUrl}/translate`, new URLSearchParams({ text, target_lang: 'EN-US' }), { headers: { Authorization: `DeepL-Auth-Key ${key}` }, timeout: 6000 });
        const detected = res.data.translations?.[0]?.detected_source_language;
        if (!detected)
            return null;
        return DEEPL_REVERSE[detected] ?? DEEPL_REVERSE[detected + '-US'] ?? null;
    }
    catch {
        return null;
    }
}
async function translateWithOpenAI(text, from, to) {
    const client = getOpenAIClient();
    if (!client)
        return null;
    const langNames = {
        pt: 'Brazilian Portuguese', en: 'English', es: 'Spanish', fr: 'French',
        de: 'German', it: 'Italian', ja: 'Japanese', zh: 'Chinese', ru: 'Russian', ar: 'Arabic',
    };
    try {
        const completion = await client.chat.completions.create({
            model: 'gpt-4o-mini',
            messages: [
                {
                    role: 'system',
                    content: `You are a professional translator. Translate the user's text from ${langNames[from]} to ${langNames[to]}. Return ONLY the translated text, no explanations.`,
                },
                { role: 'user', content: text },
            ],
            max_tokens: 500,
        });
        return completion.choices[0]?.message?.content?.trim() ?? null;
    }
    catch {
        return null;
    }
}
export async function translate(opts) {
    const { text, from, to } = opts;
    if (from === to) {
        return { text, provider: 'mock', ok: true };
    }
    const hasAnyKey = !!getDeeplKey() || !!process.env.OPENAI_API_KEY;
    // No translation service configured — pass through rather than block
    if (!hasAnyKey) {
        return { text, provider: 'mock', ok: true };
    }
    const deepl = await translateWithDeepl(text, from, to);
    if (deepl)
        return { text: deepl, provider: 'deepl', ok: true };
    const openai = await translateWithOpenAI(text, from, to);
    if (openai)
        return { text: openai, provider: 'openai', ok: true };
    return { text, provider: 'mock', ok: false };
}
export async function detectLang(text) {
    const detected = await detectWithDeepl(text);
    return detected ?? 'en';
}
