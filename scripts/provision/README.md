# scripts/provision — Telegram kanal po podcastu (MTProto)

Bot API **ne može stvoriti ni grupu ni kanal**. Zato kanal podcasta stvara ovaj
provisioner, korisničkom MTProto sesijom **zasebnog Domovina Telegram računa**
(ne osobnog). Bot ms-social-poster postaje admin i dalje sve šalje Worker
`li.domovina.ai` kroz Bot API.

Po podcastu nastaju dva objekta: **kanal** za objave (poglavlja) i povezana
**grupa za raspravu** (komentari ispod svake objave). Mapiranje
`YouTube channel_id → chat` sprema se u KV Workera (`tg:podcast:<UC…>`).

Podrijetlo: `domovinatv/novcanik-comms/provision/` (srpanj 2026., GramJS),
arhiva na `/Volumes/DOMOVINA2TB/git/`. Prebačeno na
[`teleproto`](https://github.com/sanyok12345/teleproto) jer je GramJS arhiviran
14.07.2026. Istraživanje i odluke:
`fetch.domovina.tv/docs/2026-11-19-telegram-grupa-po-kanalu.md`.

## Sigurnost

- `.env` (TG_SESSION) je ekvivalent lozinke računa. Gitignoran, nikad u repo.
  Opoziv: Telegram → Settings → Devices.
- `teleproto` (i njegov nativni `cifrante`) dobiva punu sesiju. Verzije su
  **točno pinane** (bez `^`), `package-lock.json` je commitan, a nadogradnja ide
  namjerno, uz pregled diffa paketa.

## Jednom

```sh
cd scripts/provision
npm ci
cp .env.example .env    # TG_API_ID/HASH s my.telegram.org, TG_BOT_USERNAME
npm run login           # interaktivno: broj Domovina računa → kod → 2FA; ispiše TG_SESSION
```

## Kanal za podcast

```sh
npm run create-channel -- <UC…> --title "Naziv · domovina.ai" \
  --avatar https://cdn.domovina.ai/registry/avatars/<slug>.jpg [--public <username>] [--dry-run]
```

Ako mapiranje za `<UC…>` već postoji, skripta ga samo ispiše (nema duplikata).
Ne zove se ručno u normalnom radu: `scripts/draft-episodes.ts --provision` je
pozove za podcast s pristankom (`telegram.opt_in` u registryju
`fetch.domovina.tv/data/podcasts_registry.json`) kad mu stigne prva nova
epizoda.

## Limiti (provjeriti na prvom stvarnom računu)

- ~500 kanala+grupa po računu → ~250 podcasta (dva objekta po podcastu).
- ~10 javnih `@username` po računu (20 uz Premium); default je privatni invite link.
- `FLOOD_WAIT` kod brzog stvaranja: provisioner stvara jedan podcast po pozivu.
