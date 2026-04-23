import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  HttpCode,
  HttpStatus,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateFaqDto, UpdateFaqDto } from './dto/faq.dto';
import { Public } from '../auth/public.decorator';
import { randomUUID } from 'crypto';
import { join } from 'path';
import { writeFileSync, existsSync, mkdirSync } from 'fs';

@Controller('faq')
export class FaqController {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Admin: Upload an image for FAQ content.
   * Accepts { data: "data:image/png;base64,..." } and returns { url: "/api/faq-images/uuid.ext" }
   */
  @Post('upload-image')
  async uploadImage(@Body() body: { data: string }) {
    if (!body.data || typeof body.data !== 'string') {
      throw new BadRequestException('Missing image data');
    }

    // Parse data URL: data:image/png;base64,iVBOR...
    const match = body.data.match(/^data:image\/(png|jpe?g|gif|webp|svg\+xml);base64,(.+)$/i);
    if (!match) {
      throw new BadRequestException('Invalid image data URL format');
    }

    const extMap: Record<string, string> = {
      png: 'png', jpeg: 'jpg', jpg: 'jpg', gif: 'gif', webp: 'webp', 'svg+xml': 'svg',
    };
    const ext = extMap[match[1].toLowerCase()] || 'png';
    const buffer = Buffer.from(match[2], 'base64');

    // Limit to 10MB decoded
    if (buffer.length > 10 * 1024 * 1024) {
      throw new BadRequestException('Image too large (max 10MB)');
    }

    const filename = `${randomUUID()}.${ext}`;
    const dir = join(process.cwd(), 'data', 'faq-images');
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(join(dir, filename), buffer);

    return { url: `/api/faq-images/${filename}` };
  }

  /**
   * Public: Get site contact settings (WeChat ID, QR code, etc.)
   */
  @Public()
  @Get('settings')
  async getSettings() {
    const rows = await this.prisma.siteSetting.findMany();
    const map: Record<string, string> = {};
    for (const r of rows) map[r.key] = r.value;
    return map;
  }

  /**
   * Admin: Update site settings (key-value pairs).
   * Body: { [key: string]: string }
   */
  @Patch('settings')
  async updateSettings(@Body() body: Record<string, string>) {
    const ALLOWED_KEYS = ['contact_wechat', 'contact_qrcode_url'];
    const results: Record<string, string> = {};
    for (const [key, value] of Object.entries(body)) {
      if (!ALLOWED_KEYS.includes(key)) continue;
      await this.prisma.siteSetting.upsert({
        where: { key },
        update: { value: String(value) },
        create: { key, value: String(value) },
      });
      results[key] = String(value);
    }
    return results;
  }

  /**
   * Public: Get all published FAQ items, ordered by sortOrder.
   * No authentication required.
   */
  @Public()
  @Get()
  async getPublishedFaqs() {
    return this.prisma.faqItem.findMany({
      where: { published: true },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    });
  }

  /**
   * Admin: Get ALL FAQ items (including unpublished).
   */
  @Get('all')
  async getAllFaqs() {
    return this.prisma.faqItem.findMany({
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    });
  }

  /**
   * Admin: Create a new FAQ item.
   */
  @Post()
  async createFaq(@Body() dto: CreateFaqDto) {
    return this.prisma.faqItem.create({
      data: {
        category: dto.category,
        question: dto.question,
        answer: dto.answer,
        sortOrder: dto.sortOrder ?? 0,
        published: dto.published ?? true,
      },
    });
  }

  /**
   * Admin: Update an existing FAQ item.
   */
  @Patch(':id')
  async updateFaq(@Param('id') id: string, @Body() dto: UpdateFaqDto) {
    return this.prisma.faqItem.update({
      where: { id },
      data: {
        ...(dto.category !== undefined && { category: dto.category }),
        ...(dto.question !== undefined && { question: dto.question }),
        ...(dto.answer !== undefined && { answer: dto.answer }),
        ...(dto.sortOrder !== undefined && { sortOrder: dto.sortOrder }),
        ...(dto.published !== undefined && { published: dto.published }),
      },
    });
  }

  /**
   * Admin: Delete a FAQ item.
   */
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteFaq(@Param('id') id: string) {
    await this.prisma.faqItem.delete({ where: { id } });
  }
}
