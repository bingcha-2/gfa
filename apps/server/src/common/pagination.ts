import { IsInt, IsOptional, Min, Max } from "class-validator";
import { Type } from "class-transformer";

/**
 * Shared pagination DTO — reusable across all paginated controllers.
 *
 * Usage in controllers:
 *   @Query() pagination: PaginationQuery
 *
 * Response shape:
 *   { data: T[], total: number, page: number, pageSize: number }
 */
export class PaginationQuery {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  pageSize?: number;
}

/** Standard paginated response envelope */
export type PaginatedResult<T> = {
  data: T[];
  total: number;
  page: number;
  pageSize: number;
};

/**
 * Normalize page/pageSize from raw query params.
 * Centralises the clamping logic so services don't repeat it.
 */
export function normalizePagination(raw?: {
  page?: number;
  pageSize?: number;
}): { page: number; pageSize: number; skip: number } {
  const page = Math.max(1, raw?.page ?? 1);
  const pageSize = Math.min(200, Math.max(1, raw?.pageSize ?? 100));
  return { page, pageSize, skip: (page - 1) * pageSize };
}
