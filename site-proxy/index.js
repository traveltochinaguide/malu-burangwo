// malu-site — cf1 前置代理：malu.travelchinaguide.dpdns.org 无法直接挂 Pages 自定义域名
//（dpdns.org 是公共后缀，Pages API 报 invalid TLD），改由 Worker 路由把请求透传到
// cf1 的 Pages 项目 malu-burangwo-cf1.pages.dev。只做 GET 静态透传。
export default {
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === '/ads.txt') {
      return new Response('google.com, pub-2274290381465979, DIRECT, f08c47fec0942fa0\n', {
        headers: { 'Content-Type': 'text/plain' },
      });
    }
    const target = 'https://malu-burangwo-cf1.pages.dev' + url.pathname + url.search;
    const res = await fetch(target, { headers: { 'user-agent': req.headers.get('user-agent') || 'malu-site-proxy' } });
    const headers = new Headers(res.headers);
    headers.delete('cf-ray');
    return new Response(res.body, { status: res.status, headers });
  },
};
