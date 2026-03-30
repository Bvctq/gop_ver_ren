// api/index.js
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const { kv } = require('@vercel/kv');
const app = express();

app.use(cors());
app.use(express.json());

// ════════════════════════════════════════════════════
//  2 KV KEY độc lập — lỗi 1 cái không ảnh hưởng cái kia
// ════════════════════════════════════════════════════
const KV_AFFILIATE = 'app_config';
const KV_COOKIE    = 'app_config_cookie';

const DEFAULT_AFF = {
    affiliates: [],
    affiliates_disabled: []
};

async function getAffiliateConfig() {
    try { return (await kv.get(KV_AFFILIATE)) || DEFAULT_AFF; } catch { return DEFAULT_AFF; }
}
async function getCookieConfig() {
    try { return (await kv.get(KV_COOKIE)) || {}; } catch { return {}; }
}

function authOk(req, res) {
    if (!process.env.ADMIN_KEY || req.query.key !== process.env.ADMIN_KEY) {
        res.status(403).json({ error: 'Unauthorized' });
        return false;
    }
    return true;
}

// ── Resolve short link → clean Shopee URL ────────────
const SUB_ID = "--MHX-FACEBOOK--";

async function resolveLink(rawLink) {
    let url = rawLink.replace(/[.,!?]$/, "");
    if (!/^https?:\/\//i.test(url)) url = "https://" + url;

    try {
        const r = await axios.get(url, {
            maxRedirects: 10,
            timeout: 5000,
            validateStatus: null,
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
        });

        let final = r.request.res.responseUrl || url;

        // Tối ưu Regex: Tìm cặp số ShopID và ItemID trong mọi cấu trúc Shopee
        // Dạng 1: -i.123.456 (Link có slug tiếng Việt hoặc tên ngắn)
        // Dạng 2: /product/123/456 (Link chuẩn product)
        const match = final.match(/-i\.(\d+)\.(\d+)/) || final.match(/\/product\/(\d+)\/(\d+)/);

        if (match) {
            const shopId = match[1];
            const itemId = match[2];
            
            // Tạo link sạch chuẩn 100% không chứa rác
            const pure = `https://shopee.vn/product/${shopId}/${itemId}`;
            
            // Trả về link đã được encode để đưa vào origin_link
            return encodeURIComponent(pure);
        }

        // Trường hợp sơ cua nếu không khớp regex trên (ví dụ link flash sale hoặc link đặc biệt)
        // Ta lấy phần trước dấu hỏi chấm để bỏ các tham số utm_...
        const cleanFinal = final.split('?')[0];
        return encodeURIComponent(cleanFinal);

    } catch (e) {
        console.error("Lỗi xử lý link:", e.message);
        return null;
    }
}


// ════════════════════════════════════════════════════
//  POST /api  →  Affiliate ID redirect link
//  Trả về { results } hoặc { results: [] } nếu không có config
// ════════════════════════════════════════════════════
app.post('/api', async (req, res) => {
    const content = req.body.content || '';
    if (!content) return res.json({ results: [] });

    const config = await getAffiliateConfig();
    const affiliates = config.affiliates || [];
    // Không có affiliate ID → báo no_config để frontend bỏ qua
    if (!affiliates.length) return res.json({ status: 'no_config', results: [] });

    const regex = /(?:https?:\/\/)?(?:[a-z0-9.-]*)(?:shopee\.vn|shope\.ee|s\.shopee\.vn|shp\.ee)[^\s\n\r,<>"]*/gi;
    const matches = [...new Set(content.match(regex) || [])];

    const results = await Promise.all(matches.map(async (raw) => {
        const encoded = await resolveLink(raw);
        if (!encoded) return null;
        return {
            original: raw,
            variants: affiliates.map(aff => ({
                label: aff.label,
                url: `https://s.shopee.vn/an_redir?origin_link=${encoded}&affiliate_id=${aff.id}&sub_id=${SUB_ID}`
            }))
        };
    }));

    res.json({ results: results.filter(Boolean) });
});


// ════════════════════════════════════════════════════
//  POST /convert  →  Cookie-based short link
//  Độc lập hoàn toàn với /api.
//  Cookie hết hạn → chỉ route này lỗi, /api vẫn chạy.
// ════════════════════════════════════════════════════
app.post('/convert', async (req, res) => {
    const links = req.body.links || [];
    if (!links.length) return res.json({ status: 'success', results: [] });

    const config = await getCookieConfig();
    const entries = config.cookies || config.affiliates || [];

    const validCookies = entries
        .map(e => ({
            label: e.label || 'Voucher Shopee',
            cookie: (e.cookie || e.id || '').replace(/['"]/g, '').trim()
        }))
        .filter(e => e.cookie);

    // Fallback env
    if (!validCookies.length) {
        const env = (process.env.SHOPEE_COOKIE || '').replace(/['"]/g, '').trim();
        if (env) validCookies.push({ label: 'Mặc định (Env)', cookie: env });
    }

    // Không có cookie → báo no_config để frontend bỏ qua (không throw lỗi)
    if (!validCookies.length) {
        return res.json({ status: 'no_config', results: [] });
    }

    const finalResults = links.map(link => ({ original: link, variants: [] }));

    for (const vc of validCookies) {
        const payload = {
            operationName: "batchGetCustomLink",
            query: "query batchGetCustomLink($linkParams: [CustomLinkParam!], $sourceCaller: SourceCaller) { batchCustomLink(linkParams: $linkParams, sourceCaller: $sourceCaller) { shortLink, failCode } }",
            variables: {
                linkParams: links.map(l => ({ originalLink: l })),
                sourceCaller: "CUSTOM_LINK_CALLER"
            }
        };
        try {
            const r = await axios.post(
                "https://affiliate.shopee.vn/api/v3/gql?q=batchCustomLink",
                payload,
                {
                    headers: {
                        "content-type": "application/json",
                        "cookie": vc.cookie,
                        "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15"
                    },
                    timeout: 20000
                }
            );
            (r.data?.data?.batchCustomLink || []).forEach((item, idx) => {
                if (item.shortLink) {
                    finalResults[idx].variants.push({ label: vc.label, url: item.shortLink });
                }
            });
        } catch { continue; } // Cookie lỗi → bỏ qua, thử cookie tiếp theo
    }

    res.json({ status: 'success', results: finalResults });
});


// ════════════════════════════════════════════════════
//  GET|POST /config?type=affiliate|cookie&key=ADMIN_KEY
// ════════════════════════════════════════════════════
app.get('/config', async (req, res) => {
    if (!authOk(req, res)) return;
    const data = req.query.type === 'cookie' ? await getCookieConfig() : await getAffiliateConfig();
    res.json(data);
});

app.post('/config', async (req, res) => {
    if (!authOk(req, res)) return;
    const kvKey = req.query.type === 'cookie' ? KV_COOKIE : KV_AFFILIATE;
    await kv.set(kvKey, req.body);
    res.json({ success: true, message: `Đã lưu [${req.query.type || 'affiliate'}]` });
});

app.get('/', (_, res) => res.json({
    status: 'ok',
    routes: ['POST /api', 'POST /convert', 'GET|POST /config?type=affiliate|cookie&key=...']
}));

module.exports = app;
