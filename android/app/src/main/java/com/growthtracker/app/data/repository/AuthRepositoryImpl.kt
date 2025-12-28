package com.growthtracker.app.data.repository

import android.util.Base64
import com.growthtracker.app.data.local.TokenManager
import com.growthtracker.app.data.remote.api.GrowthTrackerApi
import com.growthtracker.app.data.remote.dto.LoginRequest
import com.growthtracker.app.data.remote.dto.RegisterRequest
import com.growthtracker.app.domain.repository.AuthRepository
import com.growthtracker.app.util.ErrorUtils
import com.growthtracker.app.util.Resource
import kotlinx.coroutines.flow.Flow
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import javax.inject.Inject

class AuthRepositoryImpl @Inject constructor(
    private val api: GrowthTrackerApi,
    private val tokenManager: TokenManager
) : AuthRepository {

    override suspend fun login(identifier: String, password: String): Resource<Unit> {
        return try {
            val response = api.login(LoginRequest(identifier, password))
            if (response.success && response.accessToken != null) {
                // Decode JWT to get username and user_id
                val payload = decodeJwtPayload(response.accessToken)
                val username = payload["username"] ?: identifier
                val userId = payload["user_id"]?.toIntOrNull() ?: 0
                
                tokenManager.saveAuthData(response.accessToken, username, userId)
                Resource.Success(Unit)
            } else {
                Resource.Error(response.error ?: "Login failed")
            }
        } catch (e: Exception) {
            Resource.Error(ErrorUtils.parseError(e))
        }
    }

    override suspend fun register(email: String, username: String, password: String): Resource<Unit> {
        return try {
            val response = api.register(RegisterRequest(email, username, password))
            if (response.success) {
                // Auto-login after registration
                login(username, password)
            } else {
                Resource.Error(response.error ?: "Registration failed")
            }
        } catch (e: Exception) {
            Resource.Error(ErrorUtils.parseError(e))
        }
    }

    override suspend fun logout() {
        tokenManager.clearAll()
    }

    override fun isLoggedIn(): Flow<Boolean> = tokenManager.isLoggedIn

    override fun getCurrentUsername(): Flow<String?> = tokenManager.username

    override fun getCurrentUserId(): Flow<Int?> = tokenManager.userId

    private fun decodeJwtPayload(token: String): Map<String, String> {
        return try {
            val parts = token.split(".")
            if (parts.size >= 2) {
                val payload = String(Base64.decode(parts[1], Base64.URL_SAFE))
                val json = Json.parseToJsonElement(payload).jsonObject
                json.mapValues { it.value.jsonPrimitive.content }
            } else {
                emptyMap()
            }
        } catch (e: Exception) {
            emptyMap()
        }
    }
}
