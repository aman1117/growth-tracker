package com.growthtracker.app.data.repository

import com.growthtracker.app.data.remote.api.GrowthTrackerApi
import com.growthtracker.app.data.remote.dto.GetStreakRequest
import com.growthtracker.app.domain.model.Streak
import com.growthtracker.app.domain.repository.StreakRepository
import com.growthtracker.app.util.ErrorUtils
import com.growthtracker.app.util.Resource
import javax.inject.Inject

class StreakRepositoryImpl @Inject constructor(
    private val api: GrowthTrackerApi
) : StreakRepository {

    override suspend fun getStreak(username: String, date: String): Resource<Streak> {
        return try {
            val response = api.getStreak(GetStreakRequest(username, date))
            if (response.success && response.data != null) {
                Resource.Success(
                    Streak(
                        current = response.data.current,
                        longest = response.data.longest
                    )
                )
            } else {
                // Return default streak if not found
                Resource.Success(Streak(current = 0, longest = 0))
            }
        } catch (e: Exception) {
            Resource.Error(ErrorUtils.parseError(e))
        }
    }
}
