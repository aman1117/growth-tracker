package com.growthtracker.app.ui.dashboard

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import com.growthtracker.app.data.model.ActivityType
import java.text.SimpleDateFormat
import java.util.*

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun DashboardScreen(
    viewModel: DashboardViewModel,
    searchViewModel: com.growthtracker.app.ui.search.SearchViewModel,
    onLogout: () -> Unit
) {
    val uiState by viewModel.uiState.collectAsState()
    val searchUiState by searchViewModel.uiState.collectAsState()
    val snackbarHostState = remember { SnackbarHostState() }

    LaunchedEffect(uiState.error) {
        uiState.error?.let {
            snackbarHostState.showSnackbar(it)
            viewModel.clearError()
        }
    }

    LaunchedEffect(uiState.successMessage) {
        uiState.successMessage?.let {
            snackbarHostState.showSnackbar(it)
            viewModel.clearSuccessMessage()
        }
    }

    val signedInUser = uiState.username.ifBlank { "—" }
    val viewingUser = uiState.viewingUsername.ifBlank { signedInUser }

    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Icon(
                            imageVector = Icons.Filled.ShowChart,
                            contentDescription = "Growth Tracker Logo",
                            tint = MaterialTheme.colorScheme.primary
                        )
                        Spacer(modifier = Modifier.width(8.dp))
                        Text(
                            "Growth Tracker",
                            style = MaterialTheme.typography.titleLarge.copy(fontWeight = FontWeight.Bold),
                            color = MaterialTheme.colorScheme.primary
                        )
                    }
                },
                actions = {
                    Box(
                        modifier = Modifier
                            .clip(CircleShape)
                            .border(1.dp, MaterialTheme.colorScheme.outline, CircleShape)
                    ) {
                        IconButton(onClick = { searchViewModel.showSearch() }) {
                            Icon(
                                Icons.Filled.Search,
                                contentDescription = "Search Users",
                                tint = MaterialTheme.colorScheme.primary
                            )
                        }
                    }
                    Spacer(modifier = Modifier.width(8.dp))
                    Box(
                        modifier = Modifier
                            .clip(MaterialTheme.shapes.medium)
                            .border(1.dp, MaterialTheme.colorScheme.outline, MaterialTheme.shapes.medium)
                            .padding(horizontal = 12.dp, vertical = 8.dp)
                    ) {
                        Text(
                            viewingUser,
                            style = MaterialTheme.typography.bodyLarge,
                            color = MaterialTheme.colorScheme.primary
                        )
                    }
                    Spacer(modifier = Modifier.width(8.dp))
                    Box(
                        modifier = Modifier
                            .clip(CircleShape)
                            .border(1.dp, MaterialTheme.colorScheme.outline, CircleShape)
                    ) {
                        IconButton(onClick = onLogout) {
                            Icon(
                                Icons.Filled.ExitToApp,
                                contentDescription = "Logout",
                                tint = MaterialTheme.colorScheme.primary
                            )
                        }
                    }
                    Spacer(modifier = Modifier.width(16.dp))
                },
                colors = TopAppBarDefaults.topAppBarColors(
                    containerColor = MaterialTheme.colorScheme.surface,
                    titleContentColor = MaterialTheme.colorScheme.onSurface
                )
            )
        },
        snackbarHost = { SnackbarHost(snackbarHostState) }
    ) { paddingValues ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(paddingValues)
                .padding(16.dp)
        ) {
            if (uiState.isViewingOtherUser) {
                Card(
                    modifier = Modifier.fillMaxWidth(),
                    colors = CardDefaults.cardColors(
                        containerColor = MaterialTheme.colorScheme.secondaryContainer
                    )
                ) {
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(12.dp),
                        horizontalArrangement = Arrangement.SpaceBetween,
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        IconButton(onClick = { viewModel.returnToOwnProfile() }) {
                            Icon(
                                Icons.Filled.ArrowBack,
                                contentDescription = "Back to My Profile",
                                tint = MaterialTheme.colorScheme.onSecondaryContainer
                            )
                        }
                        Text(
                            text = "Viewing ${uiState.viewingUsername}'s Dashboard",
                            style = MaterialTheme.typography.titleMedium,
                            fontWeight = FontWeight.Bold,
                            color = MaterialTheme.colorScheme.onSecondaryContainer,
                            modifier = Modifier.weight(1f),
                            textAlign = TextAlign.Center
                        )
                        Box(modifier = Modifier.width(48.dp))
                    }
                }
                Spacer(modifier = Modifier.height(20.dp))
            }

            StreakCard(
                currentStreak = uiState.streak.current,
                longestStreak = uiState.streak.longest,
                isToday = viewModel.isNextDayDisabled()
            )

            Spacer(modifier = Modifier.height(20.dp))

            DateNavigator(
                currentDate = uiState.currentDate,
                onPrevious = { viewModel.navigateToPreviousDay() },
                onNext = { viewModel.navigateToNextDay() },
                isNextDisabled = viewModel.isNextDayDisabled()
            )

            Spacer(modifier = Modifier.height(20.dp))

            if (uiState.isLoading && uiState.activities.isEmpty()) {
                Box(
                    modifier = Modifier.fillMaxSize(),
                    contentAlignment = Alignment.Center
                ) {
                    CircularProgressIndicator()
                }
            } else {
                ActivityGrid(
                    activities = uiState.activities,
                    onActivityClick = { activity ->
                        if (!viewModel.isNextDayDisabled() || uiState.currentDate < Date()) {
                            viewModel.showActivityDialog(activity)
                        }
                    }
                )
            }
        }
    }

    if (uiState.showActivityDialog && uiState.selectedActivity != null) {
        ActivityDialog(
            activity = uiState.selectedActivity!!,
            currentHours = uiState.activities[uiState.selectedActivity] ?: 0.0,
            onDismiss = { viewModel.hideActivityDialog() },
            onSave = { hours -> viewModel.saveActivity(hours) },
            isLoading = uiState.isLoading
        )
    }

    if (searchUiState.isSearchVisible) {
        SearchDialog(
            searchQuery = searchUiState.searchQuery,
            searchResults = searchUiState.searchResults,
            isLoading = searchUiState.isLoading,
            onQueryChange = { searchViewModel.updateSearchQuery(it) },
            onUserClick = { user ->
                viewModel.viewUserProfile(user.username)
                searchViewModel.hideSearch()
            },
            onDismiss = { searchViewModel.hideSearch() }
        )
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun StreakCard(
    currentStreak: Int,
    longestStreak: Int,
    isToday: Boolean
) {
    Card(
        modifier = Modifier
            .fillMaxWidth()
            .border(1.dp, MaterialTheme.colorScheme.outline, MaterialTheme.shapes.large),
        colors = CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.surface
        ),
        shape = MaterialTheme.shapes.large,
        elevation = CardDefaults.cardElevation(defaultElevation = 0.dp)
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(20.dp),
            horizontalArrangement = Arrangement.Center,
            verticalAlignment = Alignment.CenterVertically
        ) {
            if (isToday) {
                Icon(
                    imageVector = Icons.Filled.LocalFireDepartment,
                    contentDescription = "Fire",
                    tint = Color(0xFFE7A321),
                    modifier = Modifier.size(24.dp)
                )
                Spacer(modifier = Modifier.width(8.dp))
                Text(
                    text = "Current Streak: $currentStreak",
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.ExtraBold,
                    color = MaterialTheme.colorScheme.primary
                )
                Spacer(modifier = Modifier.width(16.dp))
                Text(
                    text = "|",
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
                Spacer(modifier = Modifier.width(16.dp))
            }
            Text(
                text = "Longest Streak: $longestStreak",
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.ExtraBold,
                color = MaterialTheme.colorScheme.primary
            )
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun DateNavigator(
    currentDate: Date,
    onPrevious: () -> Unit,
    onNext: () -> Unit,
    isNextDisabled: Boolean
) {
    val dateFormat = remember { SimpleDateFormat("EEEE, MMMM d, yyyy", Locale.getDefault()) }

    Card(
        modifier = Modifier.fillMaxWidth(),
        shape = MaterialTheme.shapes.large,
        elevation = CardDefaults.cardElevation(defaultElevation = 0.dp),
        colors = CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.surface
        ),
        border = androidx.compose.foundation.BorderStroke(1.dp, MaterialTheme.colorScheme.outline)
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 12.dp, vertical = 8.dp),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically
        ) {
            IconButton(onClick = onPrevious) {
                Icon(Icons.Filled.ChevronLeft, contentDescription = "Previous Day")
            }

            Text(
                text = dateFormat.format(currentDate).uppercase(),
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.SemiBold,
                textAlign = TextAlign.Center,
                modifier = Modifier.weight(1f),
                color = MaterialTheme.colorScheme.primary
            )

            IconButton(onClick = onNext, enabled = !isNextDisabled) {
                Icon(Icons.Filled.ChevronRight, contentDescription = "Next Day")
            }
        }
    }
}

@Composable
fun ActivityGrid(
    activities: Map<ActivityType, Double>,
    onActivityClick: (ActivityType) -> Unit
) {
    LazyVerticalGrid(
        columns = GridCells.Fixed(3),
        verticalArrangement = Arrangement.spacedBy(0.dp),
        horizontalArrangement = Arrangement.spacedBy(0.dp),
        modifier = Modifier
            .fillMaxWidth()
            .border(1.dp, MaterialTheme.colorScheme.outline)
    ) {
        items(ActivityType.values().toList()) { activity ->
            ActivityTile(
                activity = activity,
                hours = activities[activity] ?: 0.0,
                onClick = { onActivityClick(activity) }
            )
        }
    }
}

@Composable
fun ActivityTile(
    activity: ActivityType,
    hours: Double,
    onClick: () -> Unit
) {
    val isActive = hours > 0
    val accent = Color(activity.color)
    val backgroundColor = if (isActive) {
        when (activity) {
            ActivityType.SLEEP -> Color(0xFFF0EFFF)
            ActivityType.STUDY -> Color(0xFFEFF4FF)
            ActivityType.BOOK_READING -> Color(0xFFFFF7ED)
            ActivityType.EATING -> Color(0xFFFFF1CC)
            ActivityType.FRIENDS -> Color(0xFFFFE6EE)
            ActivityType.GROOMING -> Color(0xFFEFE7FF)
            ActivityType.WORKOUT -> Color(0xFFFFECEC)
            ActivityType.REELS -> Color(0xFFFFE8EE)
            ActivityType.FAMILY -> Color(0xFFE9FFF4)
            ActivityType.IDLE -> Color(0xFFF3F3F3)
            ActivityType.CREATIVE -> Color(0xFFFFF1FA)
            ActivityType.TRAVELLING -> Color(0xFFE8F8FD)
            ActivityType.ERRAND -> Color(0xFFFFF4E5)
            ActivityType.REST -> Color(0xFFF3FBE7)
            ActivityType.ENTERTAINMENT -> Color(0xFFF7ECFF)
            ActivityType.OFFICE -> Color(0xFFE5F3F3)
        }
    } else {
        Color.Transparent
    }
    val iconColor = if (isActive) accent else MaterialTheme.colorScheme.primary

    Box(
        modifier = Modifier
            .aspectRatio(1f)
            .border(1.dp, MaterialTheme.colorScheme.outline)
            .background(backgroundColor)
            .clickable { onClick() },
        contentAlignment = Alignment.Center
    ) {
        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.Center,
            modifier = Modifier.padding(8.dp)
        ) {
            Icon(
                imageVector = getActivityIcon(activity),
                contentDescription = activity.displayName,
                modifier = Modifier.size(32.dp),
                tint = iconColor
            )
            Spacer(modifier = Modifier.height(6.dp))
            Text(
                text = activity.displayName,
                style = MaterialTheme.typography.labelLarge,
                fontWeight = FontWeight.SemiBold,
                textAlign = TextAlign.Center,
                color = iconColor,
                lineHeight = 14.sp,
                maxLines = 1
            )
            Spacer(modifier = Modifier.height(2.dp))
            Text(
                text = "${hours}h",
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.ExtraBold,
                color = if (isActive) accent else MaterialTheme.colorScheme.primary
            )
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ActivityDialog(
    activity: ActivityType,
    currentHours: Double,
    onDismiss: () -> Unit,
    onSave: (Double) -> Unit,
    isLoading: Boolean
) {
    var hoursText by remember { mutableStateOf(if (currentHours > 0) currentHours.toString() else "") }
    var errorMessage by remember { mutableStateOf<String?>(null) }

    Dialog(onDismissRequest = onDismiss) {
        Card(
            modifier = Modifier
                .fillMaxWidth()
                .padding(16.dp),
            shape = MaterialTheme.shapes.large,
            colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
            elevation = CardDefaults.cardElevation(defaultElevation = 8.dp)
        ) {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(24.dp),
                horizontalAlignment = Alignment.CenterHorizontally
            ) {
                Text(
                    text = "Log ${activity.displayName}",
                    style = MaterialTheme.typography.headlineSmall
                )

                Spacer(modifier = Modifier.height(16.dp))

                OutlinedTextField(
                    value = hoursText,
                    onValueChange = {
                        hoursText = it
                        errorMessage = null
                    },
                    label = { Text("Hours") },
                    placeholder = { Text("0.0") },
                    modifier = Modifier.fillMaxWidth(),
                    singleLine = true,
                    isError = errorMessage != null,
                    textStyle = MaterialTheme.typography.bodyLarge,
                    colors = TextFieldDefaults.outlinedTextFieldColors(
                        focusedBorderColor = MaterialTheme.colorScheme.primary,
                        unfocusedBorderColor = MaterialTheme.colorScheme.outline
                    )
                )

                if (errorMessage != null) {
                    Text(
                        text = errorMessage ?: "",
                        color = MaterialTheme.colorScheme.error,
                        style = MaterialTheme.typography.bodySmall,
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(top = 4.dp)
                    )
                }

                Text(
                    text = "Enter hours in increments of 0.25 (e.g., 0.25, 0.5, 1.0)",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(top = 8.dp)
                )

                Spacer(modifier = Modifier.height(24.dp))

                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween
                ) {
                    OutlinedButton(
                        onClick = onDismiss,
                        modifier = Modifier.weight(1f)
                    ) {
                        Text("Cancel")
                    }

                    Spacer(modifier = Modifier.width(8.dp))

                    Button(
                        onClick = {
                            val hours = hoursText.trim().toDoubleOrNull()
                            if (hours == null) {
                                errorMessage = "Please enter a valid number"
                            } else if (hours < 0 || hours > 24) {
                                errorMessage = "Hours must be between 0 and 24"
                            } else if ((hours * 100) % 25 != 0.0) {
                                errorMessage = "Hours must be in increments of 0.25"
                            } else {
                                onSave(hours)
                            }
                        },
                        modifier = Modifier.weight(1f),
                        enabled = !isLoading
                    ) {
                        if (isLoading) {
                            CircularProgressIndicator(
                                modifier = Modifier.size(20.dp),
                                color = MaterialTheme.colorScheme.onPrimary
                            )
                        } else {
                            Text("Save")
                        }
                    }
                }
            }
        }
    }
}

fun getActivityIcon(activity: ActivityType): ImageVector {
    return when (activity) {
        ActivityType.SLEEP -> Icons.Filled.NightShelter
        ActivityType.STUDY -> Icons.Filled.MenuBook
        ActivityType.BOOK_READING -> Icons.Filled.Book
        ActivityType.EATING -> Icons.Filled.Restaurant
        ActivityType.FRIENDS -> Icons.Filled.Group
        ActivityType.GROOMING -> Icons.Filled.Spa
        ActivityType.WORKOUT -> Icons.Filled.FitnessCenter
        ActivityType.REELS -> Icons.Filled.Movie
        ActivityType.FAMILY -> Icons.Filled.Home
        ActivityType.IDLE -> Icons.Filled.Coffee
        ActivityType.CREATIVE -> Icons.Filled.Palette
        ActivityType.TRAVELLING -> Icons.Filled.Flight
        ActivityType.ERRAND -> Icons.Filled.ShoppingBag
        ActivityType.REST -> Icons.Filled.Weekend
        ActivityType.ENTERTAINMENT -> Icons.Filled.Gamepad
        ActivityType.OFFICE -> Icons.Filled.Work
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SearchDialog(
    searchQuery: String,
    searchResults: List<com.growthtracker.app.data.model.User>,
    isLoading: Boolean,
    onQueryChange: (String) -> Unit,
    onUserClick: (com.growthtracker.app.data.model.User) -> Unit,
    onDismiss: () -> Unit
) {
    Dialog(onDismissRequest = onDismiss) {
        Card(
            modifier = Modifier
                .fillMaxWidth()
                .padding(16.dp),
            shape = MaterialTheme.shapes.large,
            colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
            elevation = CardDefaults.cardElevation(defaultElevation = 8.dp)
        ) {
            Column(
                modifier = Modifier.fillMaxWidth()
            ) {
                // Search Header
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(horizontal = 16.dp, vertical = 8.dp),
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Icon(
                        Icons.Filled.Search,
                        contentDescription = "Search",
                        modifier = Modifier.size(24.dp),
                        tint = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                    Spacer(modifier = Modifier.width(12.dp))
                    TextField(
                        value = searchQuery,
                        onValueChange = onQueryChange,
                        placeholder = { Text("Search users...") },
                        modifier = Modifier.weight(1f),
                        singleLine = true,
                        colors = TextFieldDefaults.colors(
                            focusedContainerColor = Color.Transparent,
                            unfocusedContainerColor = Color.Transparent,
                            disabledContainerColor = Color.Transparent,
                            focusedIndicatorColor = Color.Transparent,
                            unfocusedIndicatorColor = Color.Transparent,
                            disabledIndicatorColor = Color.Transparent,
                        )
                    )
                    IconButton(onClick = onDismiss) {
                        Icon(Icons.Filled.Close, contentDescription = "Close")
                    }
                }

                Divider(color = MaterialTheme.colorScheme.outline)

                // Search Results
                Box(
                    modifier = Modifier
                        .fillMaxWidth()
                        .height(300.dp)
                ) {
                    when {
                        isLoading -> {
                            Box(
                                modifier = Modifier.fillMaxSize(),
                                contentAlignment = Alignment.Center
                            ) {
                                CircularProgressIndicator()
                            }
                        }
                        searchResults.isEmpty() && searchQuery.isNotEmpty() -> {
                            Box(
                                modifier = Modifier.fillMaxSize(),
                                contentAlignment = Alignment.Center
                            ) {
                                Text(
                                    "No users found",
                                    color = MaterialTheme.colorScheme.onSurfaceVariant
                                )
                            }
                        }
                        searchResults.isNotEmpty() -> {
                            LazyColumn {
                                items(searchResults) { user ->
                                    UserSearchItem(
                                        user = user,
                                        onClick = { onUserClick(user) }
                                    )
                                    Divider(color = MaterialTheme.colorScheme.outline, modifier = Modifier.padding(horizontal = 16.dp))
                                }
                            }
                        }
                        else -> {
                            Box(
                                modifier = Modifier.fillMaxSize(),
                                contentAlignment = Alignment.Center
                            ) {
                                Text(
                                    "Search for users by username",
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                    textAlign = TextAlign.Center,
                                    modifier = Modifier.padding(16.dp)
                                )
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
fun UserSearchItem(
    user: com.growthtracker.app.data.model.User,
    onClick: () -> Unit
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .padding(16.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Box(
            modifier = Modifier
                .size(40.dp)
                .background(
                    MaterialTheme.colorScheme.secondaryContainer,
                    shape = CircleShape
                ),
            contentAlignment = Alignment.Center
        ) {
            Icon(
                Icons.Filled.Person,
                contentDescription = null,
                tint = MaterialTheme.colorScheme.onSecondaryContainer
            )
        }
        Spacer(modifier = Modifier.width(16.dp))
        Column {
            Text(
                text = user.username,
                style = MaterialTheme.typography.titleMedium
            )
        }
    }
}
