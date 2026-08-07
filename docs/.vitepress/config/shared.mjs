import { defineConfig } from 'vitepress'

export const shared = defineConfig({
    rewrites: {
        'en/:rest*': ':rest*'
    },

    title: 'MySpeed',

    lastUpdated: true,
    cleanUrls: true,
    metaChunk: true,
    ignoreDeadLinks: [
        /^http:\/\/localhost/
    ],

    sitemap: {
        hostname: 'https://docs.myspeed.dev',
        transformItems(items) {
            return items.filter((item) => !item.url.includes('migration'))
        }
    },

    /* prettier-ignore */
    head: [
        ['link', { rel: 'icon', type: 'image/png', href: '/logo.png' }],
        ['meta', { name: 'theme-color', content: '#1C2232' }],
        ['meta', { property: 'og:type', content: 'website' }],
        ['meta', { property: 'og:locale', content: 'en' }],
        ['meta', { property: 'og:title', content: 'MySpeed | Self-hosted speedtest analysis software' }],
        ['meta', { property: 'og:site_name', content: 'MySpeed' }],
        ['meta', { property: 'og:image', content: 'https://docs.myspeed.dev/assets/images/thumbnail.png' }],
        ['meta', { property: 'og:url', content: 'https://docs.myspeed.dev/' }]
    ],
    themeConfig: {
        logo: '/logo.png',
        footer: {
            copyright: '© 2022 Mathias Wagner · © 2026 Timo',
        },
        search: {
            provider: 'local'
        },
        socialLinks: [
            {icon: 'github', link: 'https://github.com/i7Gamer/MySpeed'}
        ],
    }
})