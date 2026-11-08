<div dir="rtl">

# התקנה על ה-NAS

המדריך מתאים לכל NAS שמריץ Docker: Synology (Container Manager), QNAP (Container Station), Unraid, TrueNAS. הדוגמאות בנתיבים של Synology.

## 0. מה צריך

- NAS עם Docker ו-docker compose, וגישת SSH.
- דומיין שמנוהל ב-Cloudflare (החשבון חינמי). צריך אותו בשביל כתובת HTTPS ציבורית, בלי לפתוח פורטים.
- מפתח Claude API מ-[console.anthropic.com](https://console.anthropic.com).

## 1. העתקת הפרויקט

לתיקיית הפרויקטים במחשב:

```bash
git clone --depth 1 --branch claude/dreamy-bell-lezitt https://github.com/lihai-benhaim/lihai-benhaim.git /tmp/cs
cp -r /tmp/cs/projects/content-studio ~/Projects/content-studio
cd ~/Projects/content-studio && git init && git add . && git commit -m "Initial import"
```

ומשם ל-NAS (שנה `nas` לשם/כתובת ה-NAS שלך):

```bash
rsync -av --exclude node_modules --exclude data --exclude .env \
  ~/Projects/content-studio/ nas:/volume1/docker/content-studio/
```

## 2. הגדרות

ב-NAS:

```bash
cd /volume1/docker/content-studio
cp .env.example .env
openssl rand -base64 32   # → APP_SECRET_KEY
openssl rand -hex 24      # → STUDIO_ADMIN_TOKEN
id                        # → STUDIO_UID / STUDIO_GID (המשתמש שלך ב-NAS)
mkdir -p data
```

ב-`.env`: מלא את `APP_SECRET_KEY`, `STUDIO_ADMIN_TOKEN`, `ANTHROPIC_API_KEY`, `STUDIO_UID`, `STUDIO_GID`, ואת `STUDIO_DATA_PATH=/volume1/docker/content-studio/data`. השאר את `PUBLISH_MODE=dry-run` בינתיים.

> שמור עותק של `APP_SECRET_KEY` במנהל סיסמאות. בלעדיו אי אפשר לפענח את הטוקנים השמורים, וצריך לחבר מחדש את כל החשבונות.

## 3. Cloudflare Tunnel

1. Cloudflare dashboard → Zero Trust → Networks → Tunnels → Create a tunnel → Cloudflared.
2. העתק את ה-token ל-`CLOUDFLARE_TUNNEL_TOKEN` ב-`.env`.
3. Public Hostname: `studio.<הדומיין שלך>` → Service: `http://studio:8080`.
4. ב-`.env`: `PUBLIC_BASE_URL=https://studio.<הדומיין שלך>`.

אפשרי (מומלץ): להוסיף Cloudflare Access על הכתובת כדי שגם עמוד הכניסה יהיה מאחורי התחברות. אם עושים את זה, צריך להחריג את הנתיבים `/webhooks/*`, `/media/*` ו-`/connect/*`, כי WhatsApp, Instagram והרשתות ניגשים אליהם ישירות.

## 4. הפעלה

```bash
docker compose --profile tunnel up -d --build
docker compose logs -f studio      # מחכים ל-"content studio ready"
```

גלוש ל-`https://studio.<הדומיין שלך>` והדבק את `STUDIO_ADMIN_TOKEN`. במצב dry-run אפשר כבר לנסות את כל הזרימה: בריף, תמונה, תצוגה מקדימה, אישור. הפרסום רק נרשם ולא נשלח.

## 5. חיבור הרשתות

### Instagram
1. [developers.facebook.com](https://developers.facebook.com) → Create App → Use case: "Manage messaging & content on Instagram".
2. Instagram → API setup with Instagram login → העתק `Instagram app ID` ו-`Instagram app secret` ל-`.env`.
3. Business login settings → OAuth redirect URI: `https://studio.<domain>/connect/instagram/callback`.
4. Roles → הוסף את חשבון האינסטגרם שלך כ-Instagram Tester ואשר את ההזמנה באפליקציה (Settings → Website permissions → Apps and websites).
5. ודא שהחשבון שלך מקצועי (Creator/Business).

### LinkedIn
1. [linkedin.com/developers](https://www.linkedin.com/developers/apps) → Create app (צריך לשייך לעמוד חברה כלשהו; זה לא משפיע על הפרסום בפרופיל האישי).
2. Products → הוסף "Share on LinkedIn" ו-"Sign In with LinkedIn using OpenID Connect".
3. Auth → Authorized redirect URL: `https://studio.<domain>/connect/linkedin/callback`.
4. העתק Client ID ו-Client Secret ל-`.env`.

### WhatsApp
1. באותה אפליקציית Meta: Add product → WhatsApp → API Setup.
2. העתק `Phone number ID` ו-token. ל-token קבוע: Business settings → System users → Generate token עם `whatsapp_business_messaging`.
3. App settings → Basic → `App secret` → `WHATSAPP_APP_SECRET`.
4. WhatsApp → Configuration → Webhook: `https://studio.<domain>/webhooks/whatsapp`, Verify token = הערך שבחרת ל-`WHATSAPP_VERIFY_TOKEN`. Subscribe ל-`messages`.
5. `OWNER_WHATSAPP` = המספר שלך בפורמט בינלאומי (9725...). עם מספר הבדיקה של Meta, הוסף את המספר שלך לרשימת הנמענים המותרים.

אחרי עדכון `.env`:

```bash
docker compose --profile tunnel up -d
```

ואז באתר: "חשבונות" → "חבר" לכל רשת. מוואטסאפ: לשלוח "חשבונות" ומקבלים קישורי חיבור.

## 6. מעבר לפרסום אמיתי

כשהכול נראה טוב ב-dry-run: `PUBLISH_MODE=live` ב-`.env`, ואז `docker compose up -d`. ההודעה בראש האתר תתחלף ל"פרסום אמיתי".

## גיבוי ועדכון

- **גיבוי**: כל המצב נמצא ב-`data/` (`state.json` + `media/`). מספיק לכלול את התיקייה ב-Hyper Backup / snapshot.
- **עדכון גרסה**: מעתיקים את הקוד החדש (rsync כמו בשלב 1), ואז `docker compose --profile tunnel up -d --build`.

## תקלות נפוצות

| תסמין | סיבה |
| --- | --- |
| `EACCES` על `/data` | `STUDIO_UID/GID` לא תואמים לבעלים של התיקייה. `chown -R <uid>:<gid> data` |
| Instagram: "media processing failed" / לא מצליח להוריד | `PUBLIC_BASE_URL` לא נגיש מבחוץ, או שה-tunnel לא רץ |
| וואטסאפ לא עונה | webhook לא מאומת, `OWNER_WHATSAPP` לא תואם (רק ספרות, עם קידומת מדינה), או שעברו 24 שעות מההודעה האחרונה שלך |
| `FONT_FILE not found` | מחוץ ל-Docker: הצבע על קובץ ttf עם עברית (למשל DejaVu Sans) |

</div>
