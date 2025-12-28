package com.growthtracker.app.data.repository

import com.growthtracker.app.data.remote.api.GrowthTrackerApi
import com.growthtracker.app.data.remote.dto.CreateActivityRequest
import com.growthtracker.app.data.remote.dto.GetActivitiesRequest
import com.growthtracker.app.domain.model.Activity
import com.growthtracker.app.domain.repository.ActivityRepository
import com.growthtracker.app.util.ErrorUtils
import com.growthtracker.app.util.Resource
import javax.inject.Inject

class ActivityRepositoryImpl @Inject constructor(
    private val api: GrowthTrackerApi
) : ActivityRepository {

    override suspend fun getActivities(username: String, date: String): Resource<List<Activity>> {
        return try {
            val response = api.getActivities(
                GetActivitiesRequest(
                    username = username,
                    startDate = date,
                    endDate = date
                )
            )
            if (response.success) {
                val activities = response.data.map { dto ->
                    Activity(
                        id = dto.id,
                        name = dto.name,
                        hours = dto.hours
                    )
                }
                Resource.Success(activities)
            } else {
                Resource.Error(response.error ?: "Failed to fetch activities")
            }
        } catch (e: Exception) {
            Resource.Error(ErrorUtils.parseError(e))
        }
    }

    override suspend fun createActivity(
        username: String,
        activityName: String,
        hours: Float,
        date: String
    ): Resource<Unit> {
        return try {
            val response = api.createActivity(
                CreateActivityRequest(
                    username = username,
                    activity = activityName,
                    hours = hours,
                    date = date
                )
            )
            if (response.success) {
                Resource.Success(Unit)
            } else {
                Resource.Error(response.error ?: "Failed to save activity")
            }
        } catch (e: Exception) {
            Resource.Error(ErrorUtils.parseError(e))
        }
    }
}
