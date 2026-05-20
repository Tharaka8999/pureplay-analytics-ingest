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
import { StatsService } from "./stats.service";
import { InternalApiGuard } from "../shared/auth/internal-api.guard";

@ApiTags("stats")
@ApiBearerAuth("internal_api_key")
@Controller("users")
@UseGuards(InternalApiGuard)
@SkipThrottle({ default: true, webhook: true, write: true })
@Throttle({ query: { ttl: 1_000, limit: 50 } })
export class StatsController {
  constructor(private readonly stats: StatsService) {}

  @Get(":user_id/stats")
  @ApiOperation({
    summary: "Per-club stats by canonical user ID",
    description:
      "Returns aggregate statistics (carry P50/P90, ball speed mean/stddev, lateral dispersion) grouped by club, for the given canonical user ID and time window.",
  })
  @ApiParam({ name: "user_id", description: "Canonical user ID" })
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
    description: "Filter to a single club code (e.g. 7I)",
  })
  @ApiResponse({ status: 200, description: "Aggregated per-club statistics" })
  getStats(
    @Param("user_id") userId: string,
    @Query("since") since?: string,
    @Query("until") until?: string,
    @Query("club") club?: string,
  ): Promise<unknown> {
    return this.stats.getStats(userId, { since, until, club });
  }

  @Get("by-vendor/:vendor/:vendor_user_id/stats")
  @ApiOperation({
    summary: "Per-club stats by vendor user ID",
    description:
      "Same aggregation as /users/:id/stats but scoped to a (vendor, vendor_user_id) pair. Useful before identity unification.",
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
  @ApiResponse({ status: 200, description: "Aggregated per-club statistics" })
  getStatsByVendorUser(
    @Param("vendor") vendor: string,
    @Param("vendor_user_id") vendorUserId: string,
    @Query("since") since?: string,
    @Query("until") until?: string,
    @Query("club") club?: string,
  ): Promise<unknown> {
    return this.stats.getStatsByVendorUser(vendor, vendorUserId, {
      since,
      until,
      club,
    });
  }
}
