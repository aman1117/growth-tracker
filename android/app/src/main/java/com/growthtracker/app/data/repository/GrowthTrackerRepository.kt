package com.growthtracker.app.data.repository

import android.util.Base64
import com.growthtracker.app.data.api.ApiService
import com.growthtracker.app.data.model.*
import com.growthtracker.app.data.preferences.UserPreferences
import kotlinx.coroutines.flow.first
import org.json.JSONObject

class GrowthTrackerRepository(
    private val apiService: ApiService,
    private val userPreferences: UserPreferences
) {
    // Auth Methods
    suspend fun register(email: String, username: String, password: String): Result<AuthResponse> {
        return try {
            val response = apiService.register(RegisterRequest(email, username, password))
            if (response.success && response.access_token != null) {
                val payload = decodeJwtPayload(response.access_token)
                val userId = payload.optInt("user_id", 0)
                val userName = payload.optString("username", username)
                
                userPreferences.saveAuthData(response.access_token, userName, userId)
                Result.success(response)
            } else {
                Result.failure(Exception(response.error ?: "Registration failed"))
            }
        } catch (e: Exception) {
            Result.failure(e)
        }
    }

    suspend fun login(identifier: String, password: String): Result<AuthResponse> {
        return try {
            val response = apiService.login(LoginRequest(identifier, password))
            if (response.success && response.access_token != null) {
                val payload = decodeJwtPayload(response.access_token)
                val userId = payload.optInt("user_id", 0)
                val username = payload.optString("username", identifier)
                
                userPreferences.saveAuthData(response.access_token, username, userId)
                Result.success(response)
            } else {
                Result.failure(Exception(response.error ?: "Login failed"))
            }
        } catch (e: Exception) {
            Result.failure(e)
        }
    }

    suspend fun logout() {
        userPreferences.clearAuthData()
    }

    suspend fun isLoggedIn(): Boolean {
        return userPreferences.accessToken.first() != null
    }

    suspend fun getCurrentUsername(): String? {
        return userPreferences.getUsername()
    }

    // Activity Methods
    suspend fun createActivity(
        username: String,
        activity: String,
        hours: Double,
        date: String
    ): Result<ActivityResponse> {
        return try {
            val token = userPreferences.accessToken.first() ?: return Result.failure(Exception("Not authenticated"))
            val response = apiService.createActivity(
                "Bearer $token",
                CreateActivityRequest(username, activity, hours, date)
            )
            if (response.success) {
                Result.success(response)
            } else {
                android.util.Log.e("Repository", "Create activity failed: ${response.error}")
                Result.failure(Exception(response.error ?: "Failed to create activity"))
            }
        } catch (e: Exception) {
            android.util.Log.e("Repository", "Create activity exception", e)
            Result.failure(Exception("Failed to create activity: ${e.message}"))
        }
    }

    suspend fun getActivities(
        username: String,
        startDate: String,
        endDate: String
    ): Result<List<Activity>> {
        return try {
            val token = userPreferences.accessToken.first() ?: return Result.failure(Exception("Not authenticated"))
            val response = apiService.getActivities(
                "Bearer $token",
                GetActivitiesRequest(username, startDate, endDate)
            )
            if (response.success) {
                android.util.Log.d("Repository", "Activities loaded: ${response.data.size} items")
                Result.success(response.data)
            } else {
                android.util.Log.e("Repository", "Get activities failed: ${response.error}")
                Result.failure(Exception(response.error ?: "Failed to fetch activities"))
            }
        } catch (e: Exception) {
            android.util.Log.e("Repository", "Get activities exception", e)
            Result.failure(Exception("Failed to fetch activities: ${e.message}"))
        }
    }

    suspend fun getStreak(username: String, date: String): Result<StreakData> {
        return try {
            val token = userPreferences.accessToken.first() ?: return Result.failure(Exception("Not authenticated"))
            val response = apiService.getStreak(
                "Bearer $token",
                GetStreakRequest(username, date)
            )
            if (response.success && response.data != null) {
                Result.success(response.data)
            } else {
                Result.failure(Exception(response.error ?: "Failed to fetch streak"))
            }
        } catch (e: Exception) {
            Result.failure(e)
        }
    }

    suspend fun searchUsers(query: String): Result<List<User>> {
        return try {
            val token = userPreferences.accessToken.first() ?: return Result.failure(Exception("Not authenticated"))
            val response = apiService.searchUsers(
                "Bearer $token",
                GetUsersRequest(query)
            )
            if (response.success) {
                Result.success(response.data)
            } else {
                Result.failure(Exception(response.error ?: "Failed to search users"))
            }
        } catch (e: Exception) {
            Result.failure(e)
        }
    }

    private fun decodeJwtPayload(token: String): JSONObject {
        val parts = token.split(".")
        if (parts.size < 2) return JSONObject()
        
        val payload = String(Base64.decode(parts[1], Base64.URL_SAFE))
        return JSONObject(payload)
    }
}
