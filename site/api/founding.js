// GET /api/founding -> {sold, limit}: the live counter for the Founding Shed Pro offer on the landing page.
export default async function handler(req, res) {
  const limit = Number(process.env.FOUNDING_LIMIT || 200);
  res.setHeader('Cache-Control', 'public, s-maxage=120, stale-while-revalidate=600');
  if (!process.env.LS_API_KEY || !process.env.LS_FOUNDING_PRODUCT_ID) return res.status(200).json({ sold:0, limit });
  try {
    const url = `https://api.lemonsqueezy.com/v1/license-keys?filter[product_id]=${encodeURIComponent(process.env.LS_FOUNDING_PRODUCT_ID)}&page[size]=1`;
    const data = await (await fetch(url, { headers:{ Accept:'application/vnd.api+json', Authorization:`Bearer ${process.env.LS_API_KEY}` } })).json();
    return res.status(200).json({ sold:Number(data?.meta?.page?.total) || 0, limit });
  } catch { return res.status(200).json({ sold:0, limit }); }
}
