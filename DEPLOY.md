# JoinHub — chalu karne ki poori guide

Multi-client system: har client ka apna **Meta Pixel + Access Token + Telegram channel**.
Jab koi landing se Join karke **sach me channel join** karta hai, tabhi server **Meta Conversions API**
se "Lead" bhejta hai. Bot/fake kabhi count nahi hote.

---

## A) Local par chalao (abhi test ke liye)
`joinhub` folder me:
```
node server.mjs
```
Kholo: `http://localhost:3000/dashboard.html`  · key: `change-me-123`
(Token nahi daala to **DEMO mode** — join simulate hota hai, taaki bina bot ke poora flow dekh sako.)

---

## B) Ek Telegram bot banao (ek hi bot sab clients ke liye)
1. Telegram me **@BotFather** kholo → `/newbot` → naam aur username do → **token** milega (jaise `8123:AAE...`).
2. Har client ke **channel** me ja kar: Settings → Administrators → **Add Admin** → apne bot ko add karo,
   aur **"Invite Users via Link"** permission ON rakho. (Bina iske invite link nahi banega.)

## C) Har client ke Meta details (ek baar)
Client ke **Meta Events Manager** me:
1. **Pixel ID** — Data Sources me dikhta hai.
2. **Conversions API Access Token** — Pixel → Settings → Conversions API → **Generate access token**.
3. (Optional) **Test Event Code** — Test Events tab me, testing ke liye.

Ye teen cheez dashboard me us client ke saath daaloge.

---

## D) LIVE deploy (public link) — Render (free)
> Note: public link ke liye hosting par aapka sign-in zaroori hai (ye main aapki jagah nahi kar sakta).
> Steps simple hain:

1. Code GitHub par daalo (ek repo), ya mujhe bolo to main `git` ke commands de doon.
2. **https://render.com** par sign up / login (GitHub se).
3. **New + → Blueprint** → apni repo chuno → Render `render.yaml` khud padh lega.
4. Environment me do values daalo:
   - `ADMIN_PASSWORD` = apna strong dashboard password
   - `TELEGRAM_BOT_TOKEN` = BotFather wala token
5. **Create** → thodi der me ek live URL milega: `https://joinhub-xxxx.onrender.com`
6. (Optional) us URL ko `PUBLIC_URL` env me daal do.

## E) Use karo
1. `https://aapka-link.onrender.com/dashboard.html` → key se login.
2. **Clients → + Add client**: naam, Telegram channel (@username), Pixel ID, Access Token, (test code optional) → Save.
   - Save karte hi bot channel me admin hai ya nahi, wo check ho jata hai.
3. Client card se **landing URL** copy karo (IG/FB button) → **ad me wahi URL** lagao:
   `https://aapka-link.onrender.com/?c=<clientid>&utm_source=instagram`
4. Jo real banda join karega → dashboard me **Real** badhega + Meta ko CAPI event jayega.

## Test (deploy ke baad)
- Client me **Test Event Code** daalo → ek baar khud landing se join karke dekho →
  Meta **Events Manager → Test Events** me live event dikhega → confirm ki CAPI chal raha hai.
- Pakka ho jaye to Test Event Code hata do.

---

### Kaise verify hota hai (short)
landing → **Join** → server ek **unique Telegram invite (join request)** banata hai →
banda channel join karta hai → **bot approve** karta hai → **tabhi** server **Meta CAPI** se event bhejta hai
(us client ke pixel+token se). Ek user ka ek hi event, duplicate block. Bot/no-JS click = fake, kabhi nahi bheja.
