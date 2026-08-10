-- Keep every public human-support surface on the same owner identity.
-- The contact QR stays empty until the owner supplies the real WeChat QR.
INSERT INTO "SiteSetting" ("key", "value", "updatedAt")
VALUES ('contact_name', 'Mr. 淦', CURRENT_TIMESTAMP)
ON CONFLICT("key") DO UPDATE SET
  "value" = excluded."value",
  "updatedAt" = excluded."updatedAt";

INSERT INTO "SiteSetting" ("key", "value", "updatedAt")
VALUES ('contact_wechat', '18339526286', CURRENT_TIMESTAMP)
ON CONFLICT("key") DO UPDATE SET
  "value" = excluded."value",
  "updatedAt" = excluded."updatedAt";

INSERT INTO "SiteSetting" ("key", "value", "updatedAt")
VALUES ('contact_qrcode_url', '', CURRENT_TIMESTAMP)
ON CONFLICT("key") DO UPDATE SET
  "value" = excluded."value",
  "updatedAt" = excluded."updatedAt";

-- Replace legacy named support references wherever they occur in FAQ content.
UPDATE "FaqItem"
SET
  "answer" = replace("answer", '@阿厌', 'Mr. 淦（微信：18339526286）'),
  "updatedAt" = CURRENT_TIMESTAMP
WHERE instr("answer", '@阿厌') > 0;

-- Remove legacy group-based contact instructions in favor of the direct owner contact.
UPDATE "FaqItem"
SET
  "answer" = '<ul><li><strong>客服：</strong>Mr. 淦</li><li><strong>微信：</strong>18339526286</li><li><strong>工作时间：</strong>一般 1 小时内响应。</li></ul>',
  "updatedAt" = CURRENT_TIMESTAMP
WHERE "question" = '有客服联系方式吗？';

UPDATE "FaqItem"
SET
  "answer" = '<ol><li>添加客服 Mr. 淦（微信：18339526286），说明情况。</li><li>提供订单截图 + 账号信息 + 问题描述。</li><li>客服会在 1 小时内响应处理。</li></ol>',
  "updatedAt" = CURRENT_TIMESTAMP
WHERE "question" = '售后处理步骤';
