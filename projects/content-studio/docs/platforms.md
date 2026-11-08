<div dir="rtl">

# הרשתות: מה כל אחת דורשת

"לפרסם בשמי" דרך API עובד אחרת בכל רשת. הטבלה מסכמת מה צריך כדי שהכפתור "חבר" יעבוד. המגבלות עצמן (אורך כיתוב, אורך וידאו, יחסי מסך) מוגדרות במקום אחד: `packages/core/src/platforms.ts`.

> התנאים של הרשתות משתנים. לפני שמסתמכים על פרט מסוים, כדאי לבדוק אותו בתיעוד הרשמי שמקושר בכל שורה.

| רשת | סוג חשבון שאפשר לפרסם אליו | מה צריך להקים | אישור מהרשת | מצב בפרויקט |
| --- | --- | --- | --- | --- |
| [Instagram](https://developers.facebook.com/docs/instagram-platform/content-publishing) | חשבון **מקצועי** (Creator או Business). חשבון פרטי רגיל לא נתמך ב-API. המעבר ל-Creator חינמי והפרופיל נשאר אישי | אפליקציית Meta עם "Instagram API with Instagram Login", הרשאות `instagram_business_basic` + `instagram_business_content_publish` | לשימוש עצמי (אתה admin/tester של האפליקציה) אפשר מיד. למשתמשים אחרים: App Review + אימות עסק | ✅ מתאם מלא |
| [LinkedIn](https://learn.microsoft.com/linkedin/marketing/community-management/shares/posts-api) | פרופיל אישי. עמוד חברה דורש את Community Management API | אפליקציה ב-LinkedIn Developers עם המוצרים "Share on LinkedIn" ו-"Sign In with LinkedIn using OpenID Connect" | שני המוצרים self-serve, זמינים מיד | ✅ מתאם מלא. הטוקן תקף כ-60 יום, ואז צריך לחבר שוב |
| [WhatsApp](https://developers.facebook.com/docs/whatsapp/cloud-api) (ערוץ השיחה) | מספר עסקי ב-WhatsApp Cloud API | אותה אפליקציית Meta, מוצר WhatsApp, מספר טלפון ייעודי (לא המספר שמותקן אצלך באפליקציה), webhook | מספר הבדיקה של Meta עובד מיד | ✅ |
| [Facebook](https://developers.facebook.com/docs/pages-api) | **עמוד** בלבד. פרופיל אישי לא נתמך ב-API מאז 2018 | הרשאות `pages_manage_posts` + `pages_read_engagement` באותה אפליקציית Meta | App Review | 🗺️ |
| [Threads](https://developers.facebook.com/docs/threads) | פרופיל Threads | Threads API (אותו מבנה container → publish כמו Instagram) | App Review למשתמשים אחרים | 🗺️ קרוב, דומה ל-Instagram |
| [TikTok](https://developers.tiktok.com/doc/content-posting-api-get-started) | כל חשבון | Content Posting API | עד שהאפליקציה עוברת audit, כל פוסט עולה **פרטי** (רק אתה רואה) | 🗺️ |
| [YouTube](https://developers.google.com/youtube/v3/docs/videos/insert) | ערוץ | Google Cloud project, YouTube Data API v3, OAuth consent | עד אימות הפרויקט, העלאות ננעלות כפרטיות. יש מכסה יומית של יחידות API, והעלאה צורכת חלק גדול ממנה | 🗺️ |
| [X](https://docs.x.com/x-api/posts/creation-of-a-post) | כל חשבון | X Developer account | פרסום דרך API דורש מסלול בתשלום (בחינם המכסה קטנה מאוד) | 🗺️ |
| [Pinterest](https://developers.pinterest.com/docs/api/v5/pins-create) | חשבון עסקי | Pinterest app | Standard access דורש review | 🗺️ |

## למה צריך כתובת ציבורית (Cloudflare Tunnel)

- **Instagram, Threads ו-Facebook לא מקבלים העלאת קובץ.** הם מקבלים כתובת URL ומורידים ממנה בעצמם. לכן הווידאו חייב להיות נגיש מהאינטרנט. הסטודיו מייצר קישור חתום שתקף לכמה שעות.
- **WhatsApp שולח את ההודעות שלך ל-webhook**, ולכן הוא צריך כתובת HTTPS ציבורית.
- LinkedIn, YouTube ו-X מקבלים העלאת קבצים, ולהם זה לא משנה.

Cloudflare Tunnel פותר את שני הדברים בלי לפתוח פורטים בראוטר. ההקמה ב-[nas-setup.md](nas-setup.md).

## WhatsApp: חלון 24 השעות

הודעה חופשית (טקסט, וידאו, כפתורים) אפשר לשלוח רק עד 24 שעות אחרי ההודעה האחרונה שלך. בזרימה הרגילה אתה זה שמתחיל את השיחה, כך שהתצוגה המקדימה והדוח נכנסים לחלון. אם רינדור או פרסום מסתיים אחרי יותר מ-24 שעות (למשל פרסום מתוזמן, בעתיד), צריך תבנית הודעה מאושרת (template). זה ברשימה ב-roadmap.

## חלופה: API מאוחד במקום אפליקציה לכל רשת

הצוואר בקבוק האמיתי הוא לא הקוד אלא אישורי האפליקציות (App Review של Meta, audit של TikTok, אימות של Google). יש שירותים שכבר עברו אותם ונותנים API אחד לכל הרשתות: Ayrshare, Upload-Post, Late, או Postiz (קוד פתוח, אפשר להריץ על ה-NAS).

| | מתאמים ישירים (מה שיש עכשיו) | API מאוחד |
| --- | --- | --- |
| עלות | חינם | מנוי חודשי |
| מי מחזיק את הטוקנים | רק ה-NAS שלך | השירות |
| זמן עד שעובד לכל הרשתות | שבועות (אישורים) | ימים |
| שליטה בפורמטים | מלאה | מה שהשירות תומך |

הממשק `Publisher` ב-`packages/publishers/src/types.ts` מאפשר להוסיף מתאם כזה לצד המתאמים הישירים, ולבחור לכל רשת מה משתמשים.

</div>
