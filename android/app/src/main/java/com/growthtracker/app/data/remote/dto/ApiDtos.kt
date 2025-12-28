package com.growthtracker.app.data.remote.dto

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

@Serializable
data class LoginRequest(
    val identifier: String,
    val password: String
)

@Serializable
data class RegisterRequest(
    val email: String,
    val username: String,
    val password: String
)

@Serializable
data class AuthResponse(
    val success: Boolean,
    @SerialName("access_token") val accessToken: String? = null,
    @SerialName("user_id") val userId: Int? = null,
    val username: String? = null,
    val error: String? = null
)

@Serializable
data class CreateActivityRequest(
    val username: String,
    val activity: String,
    val hours: Float,
    val date: String
)

@Serializable
data class GetActivitiesRequest(
    val username: String,
    @SerialName("start_date") val startDate: String,
    @SerialName("end_date") val endDate: String
)

@Serializable
data class ActivityDto(
    val id: Int,
    val name: String,
    val hours: Float
)

@Serializable
data class ActivitiesResponse(
    val success: Boolean,
    val data: List<ActivityDto> = emptyList(),
    val error: String? = null
)

@Serializable
data class GetStreakRequest(
    val username: String,
    val date: String
)

@Serializable
data class StreakDto(
    val id: Int,
    val current: Int,
    val longest: Int,
    val date: String? = null
)

@Serializable
data class StreakResponse(
    val success: Boolean,
    val data: StreakDto? = null,
    val error: String? = null
)

@Serializable
data class SearchUsersRequest(
    val username: String
)

@Serializable
data class UserDto(
    val id: Int,
    val username: String,
    val email: String
)

@Serializable
data class UsersResponse(
    val success: Boolean,
    val data: List<UserDto> = emptyList(),
    val error: String? = null
)

@Serializable
data class GenericResponse(
    val success: Boolean,
    val message: String? = null,
    val error: String? = null
)
