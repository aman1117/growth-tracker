package com.growthtracker.app.domain.model

import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.*
import androidx.compose.material.icons.outlined.*
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector

enum class ActivityType(
    val displayName: String,
    val apiName: String,
    val icon: ImageVector,
    val color: Color
) {
    SLEEP(
        displayName = "Sleep",
        apiName = "sleep",
        icon = Icons.Filled.Bedtime,
        color = Color(0xFF6366F1)
    ),
    STUDY(
        displayName = "Study",
        apiName = "study",
        icon = Icons.Filled.MenuBook,
        color = Color(0xFF3B82F6)
    ),
    BOOK_READING(
        displayName = "Book Reading",
        apiName = "book_reading",
        icon = Icons.Filled.AutoStories,
        color = Color(0xFF0EA5E9)
    ),
    EATING(
        displayName = "Eating",
        apiName = "eating",
        icon = Icons.Filled.Restaurant,
        color = Color(0xFFF59E0B)
    ),
    FRIENDS(
        displayName = "Friends",
        apiName = "friends",
        icon = Icons.Filled.People,
        color = Color(0xFFEC4899)
    ),
    GROOMING(
        displayName = "Grooming",
        apiName = "grooming",
        icon = Icons.Filled.Spa,
        color = Color(0xFF8B5CF6)
    ),
    WORKOUT(
        displayName = "Workout",
        apiName = "workout",
        icon = Icons.Filled.FitnessCenter,
        color = Color(0xFFEF4444)
    ),
    REELS(
        displayName = "Reels",
        apiName = "reels",
        icon = Icons.Filled.VideoLibrary,
        color = Color(0xFFF43F5E)
    ),
    FAMILY(
        displayName = "Family",
        apiName = "family",
        icon = Icons.Filled.Home,
        color = Color(0xFF10B981)
    ),
    IDLE(
        displayName = "Idle",
        apiName = "idle",
        icon = Icons.Filled.Coffee,
        color = Color(0xFF64748B)
    ),
    CREATIVE(
        displayName = "Creative",
        apiName = "creative",
        icon = Icons.Filled.Palette,
        color = Color(0xFFD946EF)
    ),
    TRAVELLING(
        displayName = "Travelling",
        apiName = "travelling",
        icon = Icons.Filled.Flight,
        color = Color(0xFF06B6D4)
    ),
    ERRAND(
        displayName = "Errand",
        apiName = "errand",
        icon = Icons.Filled.ShoppingBag,
        color = Color(0xFFF97316)
    ),
    REST(
        displayName = "Rest",
        apiName = "rest",
        icon = Icons.Filled.Weekend,
        color = Color(0xFF84CC16)
    ),
    ENTERTAINMENT(
        displayName = "Entertainment",
        apiName = "entertainment",
        icon = Icons.Filled.SportsEsports,
        color = Color(0xFFA855F7)
    ),
    OFFICE(
        displayName = "Office",
        apiName = "office",
        icon = Icons.Filled.Work,
        color = Color(0xFF0F766E)
    );

    companion object {
        fun fromApiName(name: String): ActivityType? {
            return entries.find { it.apiName == name }
        }
    }
}
