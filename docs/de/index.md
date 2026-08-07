---
layout: home

hero:
  name: MySpeed
  text: Automatisiere Speedtests
  tagline: Ein selbstgehostetes Speedtest-Tracking-Tool, das es dir ermöglicht, deine Internetverbindung zu überwachen.
  actions:
    - theme: brand
      text: Loslegen
      link: /de/setup/linux
    - theme: alt
      text: GitHub
      link: https://github.com/i7Gamer/MySpeed
  image:
    src: /logo.png
    alt: MySpeed

features:
  - icon: 📊
    title: Detaillierte Statistiken
    details: MySpeed generiert klare Statistiken zu Geschwindigkeit, Ping und mehr.
  - icon: ⏰
    title: Testautomatisierung
    details: MySpeed automatisiert Speedtests und ermöglicht es dir, die Zeit zwischen den Tests mit Cron-Ausdrücken festzulegen.
  - icon: 🗄️
    title: Mehrere Server hinzufügen
    details: Füge deiner MySpeed-Instanz mehrere Server hinzu und wechsle zwischen ihnen.
  - icon: 🩺
    title: Verwende Gesundheitsprüfungen
    details: Konfiguriere Gesundheitsprüfungen, um dich bei Fehlern oder Ausfällen per E-Mail, Signal, WhatsApp oder Telegram zu benachrichtigen.
  - icon: 🔥
    title: Unterstützung für Prometheus und Grafana
    details: Integriere direkt mit Prometheus und Grafana, um deine MySpeed-Instanz zu überwachen.
  - icon: 🗳️
    title: Wähle deinen Anbieter
    details: Wähle zwischen Ookla, LibreSpeed und Cloudflare Speedtest-Servern.


---

<style>
:root {
  --vp-home-hero-name-color: transparent;
  --vp-home-hero-name-background: -webkit-linear-gradient(120deg, #456ac6 30%, #46CA5A);

  --vp-home-hero-image-background-image: linear-gradient(#1C2232 50%, #1C2232);
  --vp-home-hero-image-filter: blur(44px);
}

@media (min-width: 640px) {
  :root {
    --vp-home-hero-image-filter: blur(56px);
  }
}

@media (min-width: 960px) {
  :root {
    --vp-home-hero-image-filter: blur(68px);
  }
}
</style>