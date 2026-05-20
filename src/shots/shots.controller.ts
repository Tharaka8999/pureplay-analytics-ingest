import { Controller, Get, Param, Query, UseGuards } from "@nestjs/common";
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiParam,
  ApiQuery,
  ApiBearerAuth,
} from "@nestjs/swagger";
import { Throttle, SkipThrottle } from "@nestjs/throttler";
import { ShotsService, type ShotsQuery } from "./shots.service";
import { InternalApiGuard } from "../shared/auth/internal-api.guard";

@ApiTags("shots")
@ApiBearerAuth("internal_api_key")
@Controller("users")
@UseGuards(InternalApiGuard)
@SkipThrottle({ default: true, webhook: true, write: true })
@Throttle({ query: { ttl: 1_000, limit: 50 } })
export class ShotsController {
  constructor(private readonly shots: ShotsService) {}

  @Get(":user_id/shots")
  @ApiOperation({
    summary: "List shots by canonical user ID",
    description:
      "Returns all shots for the given canonical user ID, normalised to the internal schema, with near-duplicates excluded by default. Paginated via keyset cursor.",
  })
  @ApiParam({
    name: "user_id",
    description: "Canonical user ID (assigned by the identity service)",
  })
  @ApiQuery({
    name: "since",
    required: false,
    description: "ISO-8601 start of window (default: 30 days ago)",
  })
  @ApiQuery({
    name: "until",
    required: false,
    description: "ISO-8601 end of window (default: now)",
  })
  @ApiQuery({
    name: "club",
    required: false,
    description: "Filter by club code (e.g. 7I, DR, PW)",
  })
  @ApiQuery({
    name: "cursor",
    required: false,
    description: "Keyset pagination cursor from previous response",
  })
  @ApiQuery({
    name: "limit",
    required: false,
    description: "Page size (max 100, default 50)",
  })
  @ApiQuery({
    name: "include_near_duplicates",
    required: false,
    description: "Include near-duplicate shots (default false)",
  })
  @ApiResponse({ status: 200, description: "Paginated shot list" })
  listByUser(
    @Param("user_id") userId: string,
    @Query("since") since?: string,
    @Query("until") until?: string,
    @Query("club") club?: string,
    @Query("cursor") cursor?: string,
    @Query("limit") limit?: string,
    @Query("include_near_duplicates") inclNearDupes?: string,
  ): Promise<unknown> {
    const query: ShotsQuery = {
      since,
      until,
      club,
      cursor,
      limit:
        limit !== undefined
          ? isNaN(parseInt(limit, 10))
            ? undefined
            : parseInt(limit, 10)
          : undefined,
      include_near_duplicates: inclNearDupes === "true",
    };
    return this.shots.listByCanonicalUser(userId, query);
  }

  @Get("by-vendor/:vendor/:vendor_user_id/shots")
  @ApiOperation({
    summary: "List shots by vendor user ID",
    description:
      "Returns shots for the given (vendor, vendor_user_id) pair. Useful before cross-vendor identity unification is implemented.",
  })
  @ApiParam({
    name: "vendor",
    description: "Vendor name: trackpro | swingmetric | proswing",
  })
  @ApiParam({
    name: "vendor_user_id",
    description: "User identifier as supplied by the vendor",
  })
  @ApiQuery({ name: "since", required: false })
  @ApiQuery({ name: "until", required: false })
  @ApiQuery({ name: "club", required: false })
  @ApiQuery({ name: "cursor", required: false })
  @ApiQuery({ name: "limit", required: false })
  @ApiQuery({ name: "include_near_duplicates", required: false })
  @ApiResponse({ status: 200, description: "Paginated shot list" })
  listByVendorUser(
    @Param("vendor") vendor: string,
    @Param("vendor_user_id") vendorUserId: string,
    @Query("since") since?: string,
    @Query("until") until?: string,
    @Query("club") club?: string,
    @Query("cursor") cursor?: string,
    @Query("limit") limit?: string,
    @Query("include_near_duplicates") inclNearDupes?: string,
  ): Promise<unknown> {
    const query: ShotsQuery = {
      since,
      until,
      club,
      cursor,
      limit:
        limit !== undefined
          ? isNaN(parseInt(limit, 10))
            ? undefined
            : parseInt(limit, 10)
          : undefined,
      include_near_duplicates: inclNearDupes === "true",
    };
    return this.shots.listByVendorUser(vendor, vendorUserId, query);
  }
}
