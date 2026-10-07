# Skyblock Forge Flip

Hypixel Skyblock'taki forge tariflerinin hangisinin en çok kâr getirdiğini gösteren bir web sitesi.

- **En kârlı:** Tüm forge tarifleri; item başına kâr, saatlik kâr, kâr oranı, maliyet veya süreye göre sıralanır. Bazaar / Auction House filtresi vardır.
- **Karşılaştır:** Seçtiğin itemler yan yana, kâr geçmişi grafiğiyle birlikte.
- **NPC vs Bazaar:** NPC satış fiyatı olan her Bazaar iteminde NPC'ye mi Bazaar'a mı satmanın daha iyi olduğu, ve Bazaar'dan alıp NPC'ye satmanın (NPC flip) adet başına kârı. "Farming" görünümü seçili farming itemlerinde (Enchanted Hay Bale, Mutant Nether Wart, Polished Pumpkin, Fermento, Helianthus vb.) NPC ve Bazaar fiyatını yan yana gösterir.
- **Craft mı al mı:** Crafting table tarifi olan her itemde hazır almak mı (Bazaar ya da AH lowest BIN) malzemeleri alıp craftlamak mı daha ucuz, ve craftlayıp satmanın kârı. İstersen malzemelerin alt tarifleri de hesaba katılır.
- **Detay:** Bir satıra tıklayınca malzeme dökümü, her malzemenin ve çıktının fiyat geçmişi grafiği, elle fiyat girme.
- **Profil ve ayarlar:** Kullanıcı adınla forge slot sayını ve Quick Forge seviyeni çeker; istersen bunları elle girersin.

## Hesap nasıl yapılıyor

| | Kaynak |
|---|---|
| Malzeme maliyeti | Seçime göre Bazaar anında alım (satış emirleri gerekli adet kadar taranır) ya da buy order (en yüksek alış emrinin 0.1 üstü). Bazaar'da yoksa AH lowest BIN. |
| Satış (Bazaar) | Seçime göre sell offer (en düşük satış emrinin 0.1 altı) ya da anında satış (en yüksek alış emri), eksi Bazaar vergisi (varsayılan %1.25, ayarlardan değişir). |
| Satış (AH) | Lowest BIN, eksi ilan ücreti (%1 / %2 / %2.5) ve 1M üstü için %1 tahsil vergisi. |
| Süre | Tarif süresi, Quick Forge indirimiyle (seviye başına %10 + %0.5, seviye 20'de %30). |
| Kâr / saat | Item başına kâr ÷ forge süresi (tek slot). Günlük kâr slot sayınla çarpılır. 10 dakikadan kısa süren forgelar saatlik sıralamada varsayılan olarak gizlenir, çünkü o hızda satacak alıcı bulunmaz. |

Forge slot sayısı HotM seviyesinden tahmin edilir (HotM 1–2: 2, HotM 3: 3, HotM 4: 4, HotM 5+: 5). Farklıysa ayarlardan elle gir.

## Nasıl çalışıyor

- `scripts/build-recipes.mjs` forge ve crafting table tariflerini [NotEnoughUpdates-REPO](https://github.com/NotEnoughUpdates/NotEnoughUpdates-REPO)'dan günde bir kez okur.
- `scripts/collect.mjs` Hypixel'in herkese açık Bazaar ve Auction House API'lerinden fiyatları alır.
- `.github/workflows/collect.yml` bunları **15 dakikada bir** çalıştırır ve sonuçları `data` dalına yazar (`recipes.json`, `crafts.json`, `latest.json`, `market.json`, `npc.json`, `history/<ITEM>.json`, son 30 gün). `market.json` tüm Bazaar ve AH itemlerinin anlık fiyatını tutar (geçmişi yok); `npc.json` NPC satış fiyatlarını Hypixel'in item listesinden günde bir kez alır. `data` dalı her seferinde tek bir commit olarak yeniden yazılır, böylece repo büyümez.
- Site (`index.html`, `js/app.js`, `css/style.css`) bu dosyaları okur. Sunucu gerekmez.

## Kurulum (bir kez)

1. **Fiyat toplayıcıyı başlat:** GitHub'da repo → **Actions** → "Collect prices" → **Run workflow**. Sonra her 15 dakikada bir kendiliğinden çalışır.
2. **Siteyi yayınla:** repo → **Settings** → **Pages** → Source: "Deploy from a branch", Branch: `main`, klasör `/ (root)` → **Save**. Site birkaç dakika sonra `https://mitocet.github.io/skyblock-forge-flip/` adresinde açılır.
3. **Profil:** Sitede "Profil ve ayarlar" sekmesine kullanıcı adını ve Hypixel API anahtarını gir, "Profili çek"e bas. Anahtar sadece tarayıcında saklanır ve sadece `api.hypixel.net`'e gönderilir. Development Key 3 günde bir yenilenmeli.

Bilgisayarında açmak için `index.html` dosyasını tarayıcıda açman da yeterli; veriyi yine GitHub'daki `data` dalından okur.

## Notlar

- Fiyat geçmişi toplayıcının ilk çalıştığı andan itibaren birikir.
- GitHub zamanlanmış görevleri yoğun saatlerde birkaç dakika gecikebilir.
- Oyuncu adından UUID bulmak için playerdb.co (yedek: ashcon.app) kullanılır, çünkü Mojang API'si tarayıcıdan çağrılamıyor.
