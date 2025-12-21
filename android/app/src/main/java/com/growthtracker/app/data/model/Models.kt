package com.growthtracker.app.data.model

import kotlinx.serialization.Serializable

@Serializable
data class User(
    val id: Int,
    val username: String,
    val email: String
)

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
    val access_token: String? = null,
    val token_type: String? = null,
    val expires_at: String? = null,
    val expires_in: Int? = null,
    val error: String? = null
)

@Serializable
data class Activity(
    val id: Int,
    val name: String,
    val hours: Double,
    val date: String? = null
)

@Serializable
data class CreateActivityRequest(
    val username: String,
    val activity: String,
    val hours: Double,
    val date: String
)

@Serializable
data class GetActivitiesRequest(
    val username: String,
    val start_date: String,
    val end_date: String
)

@Serializable
data class ActivityResponse(
    val success: Boolean,
    val data: List<Activity> = emptyList(),
    val error: String? = null
)

@Serializable
data class GetStreakRequest(
    val username: String,
    val date: String
)

@Serializable
data class StreakData(
    val current: Int,
    val longest: Int
)

@Serializable
data class StreakResponse(
    val success: Boolean,
    val data: StreakData? = null,
    val error: String? = null
)

@Serializable
data class GetUsersRequest(
    val username: String
)

@Serializable
data class GetUsersResponse(
    val success: Boolean,
    val data: List<User> = emptyList(),
    val error: String? = null
)

enum class ActivityType(val displayName: String, val color: Long) {
    SLEEP("Sleep", 0xFF6366F1),
    STUDY("Study", 0xFF3B82F6),
    BOOK_READING("Book Reading", 0xFF0EA5E9),
    EATING("Eating", 0xFFF59E0B),
    FRIENDS("Friends", 0xFFEC4899),
    GROOMING("Grooming", 0xFF8B5CF6),
    WORKOUT("Workout", 0xFFEF4444),
    REELS("Reels", 0xFFF43F5E),
    FAMILY("Family", 0xFF10B981),
    IDLE("Idle", 0xFF64748B),
    CREATIVE("Creative", 0xFFD946EF),
    TRAVELLING("Travelling", 0xFF06B6D4),
    ERRAND("Errand", 0xFFF97316),
    REST("Rest", 0xFF84CC16),
    ENTERTAINMENT("Entertainment", 0xFFA855F7),
    OFFICE("Office", 0xFF0F766E);

    companion object {
        fun fromApiName(apiName: String): ActivityType {
            return when (apiName.lowercase()) {
                "sleep" -> SLEEP
                "study" -> STUDY
                "book_reading" -> BOOK_READING
                "eating" -> EATING
                "friends" -> FRIENDS
                "grooming" -> GROOMING
                "workout" -> WORKOUT
                "reels" -> REELS
                "family" -> FAMILY
                "idle" -> IDLE
                "creative" -> CREATIVE
                "travelling" -> TRAVELLING
                "errand" -> ERRAND
                "rest" -> REST
                "entertainment" -> ENTERTAINMENT
                "office" -> OFFICE
                else -> IDLE
            }
        }

        fun toApiName(type: ActivityType): String {
            return when (type) {
                SLEEP -> "sleep"
                STUDY -> "study"
                BOOK_READING -> "book_reading"
                EATING -> "eating"
                FRIENDS -> "friends"
                GROOMING -> "grooming"
                WORKOUT -> "workout"
                REELS -> "reels"
                FAMILY -> "family"
                IDLE -> "idle"
                CREATIVE -> "creative"
                TRAVELLING -> "travelling"
                ERRAND -> "errand"
                REST -> "rest"
                ENTERTAINMENT -> "entertainment"
                OFFICE -> "office"
            }
        }
    }
}
