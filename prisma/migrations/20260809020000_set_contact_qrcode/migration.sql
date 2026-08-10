-- Publish the verified WeChat add-friend QR supplied by Mr. 淦.
INSERT INTO "SiteSetting" ("key", "value", "updatedAt")
VALUES ('contact_qrcode_url', '/api/faq-images/mr-gan-wechat-qr.jpg', CURRENT_TIMESTAMP)
ON CONFLICT("key") DO UPDATE SET
  "value" = excluded."value",
  "updatedAt" = excluded."updatedAt";
