package com.growthtracker.app.domain.repository

import com.growthtracker.app.domain.model.Activity
import com.growthtracker.app.domain.model.Streak
import com.growthtracker.app.domain.model.User
import com.growthtracker.app.util.Resource
import kotlinx.coroutines.flow.Flow

interface AuthRepository {
    suspend fun login(identifier: String, password: String): Resource<Unit>
    suspend fun register(email: String, username: String, password: String): Resource<Unit>
    suspend fun logout()
    fun isLoggedIn(): Flow<Boolean>
    fun getCurrentUsername(): Flow<String?>
    fun getCurrentUserId(): Flow<Int?>
}

interface ActivityRepository {
    suspend fun getActivities(username: String, date: String): Resource<List<Activity>>
    suspend fun createActivity(username: String, activityName: String, hours: Float, date: String): Resource<Unit>
}

interface StreakRepository {
    suspend fun getStreak(username: String, date: String): Resource<Streak>
}

interface UserRepository {
    suspend fun searchUsers(query: String): Resource<List<User>>
}
